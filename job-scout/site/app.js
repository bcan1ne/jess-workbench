/**
 * Job Scout dashboard.
 *
 * Ported from the Apps Script version. Everything google.script.run used to do
 * is now either a fetch against a committed JSON file or a local computation:
 *
 *   getDashboardData()  -> fetch jobs.json + locals.json + config.json
 *   updateJobStatus()   -> localStorage, exported by hand when she wants it durable
 *   runRefresh()        -> the GitHub Actions workflow; the sidebar links to it
 *   updateDrivingDist() -> computed here from config.json, same math as the sheet
 */

var DATA = { jobs: [], rawJobs: [], locals: [], companies: [], config: {}, committedStatuses: {}, branch: null };
var FILTER = 'all';
var STORE_KEY = 'jobScout.statuses.v1';
var QUERY = '';
var SORT = { key: 'fit', dir: 'desc' };
var EXPANDED = {};
var ONLY = { remote: false, clears: false, radius: false };
var TOKEN_KEY = 'jobScout.ghToken.v1';
var RESUME_KEY = 'jobScout.resume.v1';
var ANTH_KEY = 'jobScout.anthKey.v1';
var TAILORING = false;
var LAST_TAILOR = null;
var REFRESHING = false;
var lastFocus = null;

var BANDS = [
  { key:'high', label:'Apply first',  desc:'Strong match on experience and pay',          tone:'var(--tag-high)', test:function(j){return j.fit>=8;} },
  { key:'mid',  label:'Worth a look', desc:'One meaningful gap or open question',          tone:'var(--tag-mid)',  test:function(j){return j.fit>=6&&j.fit<8;} },
  { key:'low',  label:'Stretch',      desc:'Real caveat — read the note before applying',  tone:'var(--tag-low)',  test:function(j){return j.fit>0&&j.fit<6;} }
];
var STATUSES = ['Not started','Applied','Screening','Offer','Passed'];

function $(id){ return document.getElementById(id); }

function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function toast(msg, bad){
  var t=$('toast');
  t.textContent=msg;
  t.className='toast show'+(bad?' bad':'');
  clearTimeout(t._t);
  t._t=setTimeout(function(){t.className='toast';},4600);
}

/* ------------------------------------------------------------- storage */
/* Every read and write is guarded — a private window or blocked site data
   throws on access rather than returning null. */

function readStore(){
  try{
    var raw=localStorage.getItem(STORE_KEY);
    return raw?JSON.parse(raw):{};
  }catch(err){ return {}; }
}

function writeStore(map){
  try{
    localStorage.setItem(STORE_KEY,JSON.stringify(map));
    return true;
  }catch(err){ return false; }
}

function readLocal(key){
  try{ return localStorage.getItem(key)||''; }catch(err){ return ''; }
}

function writeLocal(key,v){
  try{
    if(v) localStorage.setItem(key,v); else localStorage.removeItem(key);
    return true;
  }catch(err){ return false; }
}

function readToken(){
  try{ return localStorage.getItem(TOKEN_KEY)||''; }catch(err){ return ''; }
}

function writeToken(v){
  try{
    if(v) localStorage.setItem(TOKEN_KEY,v); else localStorage.removeItem(TOKEN_KEY);
    return true;
  }catch(err){ return false; }
}

/**
 * The committed map is the truth — that is what makes a status the same on every
 * browser. The local copy is only a cache, used before the first sync lands and
 * when there is no token to sync with.
 */
function statusFor(job){
  if(DATA.committedStatuses[job.url]) return DATA.committedStatuses[job.url];
  if(!readToken()){
    var local=readStore();
    if(local[job.url]) return local[job.url];
  }
  return job.status||'Not started';
}

/* -------------------------------------------------------------- geo */
/* Same spherical law of cosines the spreadsheet used, so the numbers on the
   board match the numbers in the workbook. */

function rad(d){ return d*Math.PI/180; }

function straightMiles(lat, lon, cfg){
  if(lat==null||lon==null) return null;
  var c = Math.cos(rad(90-cfg.lat))*Math.cos(rad(90-lat))
        + Math.sin(rad(90-cfg.lat))*Math.sin(rad(90-lat))*Math.cos(rad(cfg.lon-lon));
  return Math.round(Math.acos(Math.min(1,c))*3959*10)/10;
}

function drivingMiles(lat, lon, cfg){
  var s=straightMiles(lat,lon,cfg);
  if(s==null) return null;
  return Math.round(s*(cfg.multiplier||1)*10)/10;
}

function distanceLabel(job){
  var d=drivingMiles(job.lat,job.lon,DATA.config);
  return d==null?'Remote':d+' mi';
}

function inRadius(job){
  var d=drivingMiles(job.lat,job.lon,DATA.config);
  if(d==null) return 'Yes - remote';
  return d<=DATA.config.radius?'Yes':'No';
}

function salaryCheck(job){
  if(job.salaryMin==null) return 'Not posted - verify';
  return job.salaryMin>=DATA.config.minSalary?'Clears floor':'Below floor';
}

/* -------------------------------------------------------------- links */
/* Derived from the Pages URL so nothing hardcodes the repository name. */

function repoSlug(){
  // config.json wins, so the board works from any host — Pages, a local
  // preview, or somewhere else entirely. The derivation is only a fallback.
  if(DATA.config&&DATA.config.repo) return DATA.config.repo;
  var host=location.hostname;
  var owner=host.indexOf('.github.io')>0?host.split('.')[0]:null;
  var seg=location.pathname.split('/').filter(Boolean);
  if(owner&&seg.length) return owner+'/'+seg[0];
  return null;
}

function wireLinks(){
  var slug=repoSlug();
  var base=slug?'https://github.com/'+slug:'https://github.com';
  $('actionsLink').href=slug?base+'/actions/workflows/job-scout.yml':base;
  $('configLink').href=slug?base+'/blob/HEAD/job-scout/config.json':base;
  if(slug) $('tokenLink').href='https://github.com/settings/personal-access-tokens/new';
  // Name the repository in the walkthrough so there is nothing to guess at.
  if(slug) $('repoNameHint').textContent=slug.split('/')[1];
}

/* -------------------------------------------------------------- load */

function getJson(file, fallback){
  return fetch(file,{cache:'no-store'}).then(function(r){
    if(!r.ok) throw new Error(file+' returned '+r.status);
    return r.json();
  }).catch(function(err){
    if(fallback!==undefined) return fallback;
    throw err;
  });
}

function load(){
  Promise.all([
    getJson('config.json'),
    getJson('jobs.json'),
    getJson('locals.json',[]),
    getJson('statuses.json',{})
  ]).then(function(res){
    DATA.config=res[0];
    DATA.locals=res[2]||[];
    DATA.committedStatuses=res[3]||{};
    DATA.rawJobs=res[1]||[];
    // statusFor reads committedStatuses, so resolve only once it is in place.
    DATA.jobs=DATA.rawJobs.map(function(j){
      var copy=Object.assign({},j);
      copy.status=statusFor(j);
      return copy;
    });
    wireLinks();
    $('skeleton').hidden=true;
    $('tableView').hidden=false;
    render(); renderLocals(); fillSettings();
    loadCompanies();
    // The published copies lag a Pages deploy behind. With a token, re-read the
    // committed files directly so every browser agrees as soon as it opens.
    return syncFromRepo();
  }).catch(function(err){
    $('skeleton').hidden=true;
    $('tableView').hidden=false;
    $('tableEmpty').innerHTML=
      '<div class="empty"><h3>Could not load the board</h3><p>'+esc(err.message||err)+'</p></div>';
    $('railFoot').textContent='Board unavailable';
  });
}

/* ------------------------------------------------------------ filters */

/** Everything except the status filter, so the status counts stay meaningful. */
function jobsBeforeStatusFilter(){
  return DATA.jobs.filter(function(j){
    if(!matchesQuery(j)) return false;
    if(ONLY.remote&&!isRemote(j)) return false;
    if(ONLY.clears&&!clearsFloor(j)) return false;
    if(ONLY.radius&&!withinRadius(j)) return false;
    return true;
  });
}

function renderFilters(){
  var pool=jobsBeforeStatusFilter();
  var counts={all:pool.length};
  STATUSES.forEach(function(st){
    counts[st]=pool.filter(function(j){return j.status===st;}).length;
  });

  var opts=[{k:'all',t:'Everything'}].concat(
    STATUSES.filter(function(st){return counts[st]>0||st==='Not started'||FILTER===st;})
            .map(function(st){return {k:st,t:st};}));
  $('filters').innerHTML=opts.map(function(o){
    return '<button class="chip" type="button" aria-pressed="'+(FILTER===o.k)+
      '" data-filter="'+esc(o.k)+'">'+esc(o.t)+
      '<span class="n">'+(counts[o.k]||0)+'</span></button>';
  }).join('');

  renderOnly();

  $('clearFilters').hidden=!filtersActive();

  var shown=visibleJobs().length;
  var top=DATA.jobs.filter(function(j){return j.fit>=8;}).length;
  $('railFoot').textContent = filtersActive()
    ? shown+' of '+DATA.jobs.length+' listings shown'
    : DATA.jobs.length+' listings tracked · '+top+' in the top band';
}

/** Counts show what each toggle would leave, given the others already on. */
function renderOnly(){
  var defs=[
    { key:'remote', label:'Remote',            test:isRemote },
    { key:'clears', label:'Clears salary floor', test:clearsFloor },
    { key:'radius', label:'Within radius',     test:withinRadius }
  ];
  $('onlyFilters').innerHTML=defs.map(function(d){
    var n=DATA.jobs.filter(function(j){
      if(FILTER!=='all'&&j.status!==FILTER) return false;
      if(!matchesQuery(j)) return false;
      var others=defs.every(function(o){
        return o.key===d.key||!ONLY[o.key]||o.test(j);
      });
      return others&&d.test(j);
    }).length;
    return '<label class="check'+(ONLY[d.key]?' on':'')+'">'+
      '<input type="checkbox" data-only="'+d.key+'"'+(ONLY[d.key]?' checked':'')+'>'+
      esc(d.label)+'<span class="n">'+n+'</span></label>';
  }).join('');
}

function setFilter(k){ FILTER=k; render(); }

function setQuery(q){ QUERY=q.trim(); render(); }

function setOnly(key,on){ ONLY[key]=!!on; render(); }

function clearAllFilters(){
  FILTER='all'; QUERY=''; ONLY={remote:false,clears:false,radius:false};
  $('search').value='';
  render();
}

/* ------------------------------------------------------------ filtering */

function bandFor(job){
  for(var i=0;i<BANDS.length;i++) if(BANDS[i].test(job)) return BANDS[i];
  return BANDS[BANDS.length-1];
}

function matchesQuery(job){
  if(!QUERY) return true;
  var hay=[job.company,job.title,job.industry,job.location,job.why,job.watchOuts,job.setup]
    .join(' ').toLowerCase();
  // every word must appear somewhere, so "maven remote" narrows rather than widens
  return QUERY.toLowerCase().split(/\s+/).filter(Boolean)
    .every(function(w){ return hay.indexOf(w)!==-1; });
}

function isRemote(job){ return /remote/i.test(job.setup||'')||/remote/i.test(job.location||''); }
function clearsFloor(job){ return job.salaryMin!=null&&job.salaryMin>=DATA.config.minSalary; }
function withinRadius(job){
  var d=drivingMiles(job.lat,job.lon,DATA.config);
  return d==null||d<=DATA.config.radius;
}

/** The one list both views render, so they never disagree. */
function visibleJobs(){
  return DATA.jobs.filter(function(j){
    if(FILTER!=='all'&&j.status!==FILTER) return false;
    if(!matchesQuery(j)) return false;
    if(ONLY.remote&&!isRemote(j)) return false;
    if(ONLY.clears&&!clearsFloor(j)) return false;
    if(ONLY.radius&&!withinRadius(j)) return false;
    return true;
  });
}

function filtersActive(){
  return FILTER!=='all'||!!QUERY||ONLY.remote||ONLY.clears||ONLY.radius;
}

/* -------------------------------------------------------------- sorting */

var COLUMNS = [
  { key:'fit',      label:'Fit',     sort:function(j){ return j.fit||0; } },
  { key:'company',  label:'Company', sort:function(j){ return (j.company||'').toLowerCase(); } },
  { key:'title',    label:'Role',    sort:function(j){ return (j.title||'').toLowerCase(); } },
  { key:'salary',   label:'Salary',  sort:function(j){ return j.salaryMin==null?-Infinity:j.salaryMin; } },
  { key:'setup',    label:'Setup',   sort:function(j){ return (j.setup||'').toLowerCase(); } },
  // Remote sorts as no commute at all, which is what she is optimising for.
  { key:'drive',    label:'Drive',   sort:function(j){
      var d=drivingMiles(j.lat,j.lon,DATA.config); return d==null?-1:d; } },
  { key:'posted',   label:'Posted',  sort:function(j){ return j.firstSeen||''; },
    hint:'Sorts by when the listing was first seen' },
  { key:'status',   label:'Status',  sort:function(j){ return STATUSES.indexOf(j.status); } }
];

function columnFor(key){
  for(var i=0;i<COLUMNS.length;i++) if(COLUMNS[i].key===key) return COLUMNS[i];
  return COLUMNS[0];
}

function sortJobs(jobs){
  var col=columnFor(SORT.key);
  var dir=SORT.dir==='asc'?1:-1;
  return jobs.slice().sort(function(a,b){
    var va=col.sort(a), vb=col.sort(b);
    if(va<vb) return -1*dir;
    if(va>vb) return 1*dir;
    // Fit breaks every other tie, so equal rows stay in triage order.
    return (b.fit||0)-(a.fit||0);
  });
}

function setSort(key){
  if(SORT.key===key){
    SORT.dir=SORT.dir==='asc'?'desc':'asc';
  }else{
    SORT.key=key;
    // Numbers read best highest-first; text reads best A-Z.
    SORT.dir=(key==='company'||key==='title'||key==='setup')?'asc':'desc';
  }
  renderTable();
}

/* -------------------------------------------------------------- board */

function emptyMessage(){
  if(!DATA.jobs.length){
    return '<div class="empty"><h3>Nothing here yet</h3><p>No listings on the board yet. '+
      'Use Refresh listings in the sidebar to start one.</p></div>';
  }
  return '<div class="empty"><h3>No matches</h3><p>Nothing fits the current filters. '+
    'Clear them in the sidebar to see all '+DATA.jobs.length+' listings.</p></div>';
}

/** Re-renders the board and the counts around it. */
function render(){
  renderFilters();
  renderTable();
}

/* -------------------------------------------------------------- table */

/** "$100,000 - $156,000" -> "$100k–156k". Full text stays in the note. */
function shortSalary(job){
  var t=job.salary||'';
  var m=t.match(/\$\s*([\d,]+)\s*[-–—to]+\s*\$\s*([\d,]+)/i);
  var k=function(n){
    var v=Number(String(n).replace(/,/g,''));
    if(!v) return null;
    return '$'+(v>=1000?Math.round(v/1000)+'k':v);
  };
  if(m&&k(m[1])&&k(m[2])) return k(m[1])+'–'+String(k(m[2])).replace('$','');
  var one=t.match(/\$\s*([\d,]+)/);
  if(one&&k(one[1])) return k(one[1]);
  return t?'—':'—';
}

/**
 * "Reposted 11 hours ago" -> "11h ago ↻". The recency is the useful part, so
 * truncation must not eat it. Full text stays in the tooltip and the note.
 */
function shortPosted(job){
  var t=(job.posted||'').trim();
  if(!t) return '—';
  if(/undated|verify/i.test(t)) return 'undated';
  if(/within the last day|today/i.test(t)) return '<1d ago';

  var re=/^(re)?posted\s*/i;
  var again=/^reposted/i.test(t);
  var rest=t.replace(re,'').trim();

  var m=rest.match(/^~?\s*([\d.]+)\s*(hour|day|week|month|year)s?\s*ago/i);
  if(m){
    var unit={hour:'h',day:'d',week:'w',month:'mo',year:'y'}[m[2].toLowerCase()];
    return (/^~/.test(rest)?'~':'')+m[1]+unit+' ago'+(again?' ↻':'');
  }
  return rest+(again?' ↻':'');
}

/** Long setup strings collapse to the token that matters for scanning. */
function shortSetup(job){
  var t=(job.setup||'')+' '+(job.location||'');
  if(/hybrid/i.test(t)) return /remote/i.test(job.setup||'')?'Remote/Hyb':'Hybrid';
  if(/remote/i.test(t)) return 'Remote';
  if(/on-?site|in-?office/i.test(t)) return 'On-site';
  return job.setup||'—';
}

function renderTable(){
  var jobs=sortJobs(visibleJobs());
  $('tableCount').textContent=jobs.length+(jobs.length===1?' listing':' listings');

  $('tableHead').innerHTML=COLUMNS.map(function(c){
    var active=SORT.key===c.key;
    var dir=active?(SORT.dir==='asc'?'ascending':'descending'):null;
    var arrow=active?(SORT.dir==='asc'?'↑':'↓'):'';
    return '<th scope="col"'+(dir?' aria-sort="'+dir+'"':'')+'>'+
      '<button type="button" data-sort="'+c.key+'"'+
      (c.hint?' title="'+esc(c.hint)+'"':'')+'>'+esc(c.label)+
      '<span class="dir" aria-hidden="true">'+arrow+'</span></button></th>';
  }).join('');

  if(!jobs.length){
    $('tableBody').innerHTML='';
    $('tableEmpty').innerHTML=emptyMessage();
    return;
  }
  $('tableEmpty').innerHTML='';

  $('tableBody').innerHTML=jobs.map(function(j,i){
    return tableRow(j,i);
  }).join('');
}

function tableRow(j,i){
  var band=bandFor(j);
  var open=!!EXPANDED[j.url];
  var id='det'+i;
  var check=salaryCheck(j);
  var salCls = check==='Below floor' ? ' warn' : check==='Clears floor' ? ' good' : '';
  var selId='tst'+i;

  var row='<tr class="row'+(open?' open':'')+'" style="--tone:'+band.tone+'">'+
    '<td><span class="fitcell" title="'+esc(band.label)+' — '+esc(band.desc)+'">'+
      esc(j.fit)+'</span></td>'+
    '<td class="cell-co" title="'+esc(j.company)+'">'+esc(j.company)+'</td>'+
    '<td><button class="rowbtn" type="button" data-toggle="'+esc(j.url)+'" '+
      'aria-expanded="'+open+'" aria-controls="'+id+'" title="'+esc(j.title)+'">'+
      '<span class="chev" aria-hidden="true">▸</span>'+
      '<span class="txt">'+esc(j.title)+'</span></button></td>'+
    '<td class="cell-mono'+salCls+'" title="'+esc(j.salary||'Not posted')+'">'+esc(shortSalary(j))+'</td>'+
    '<td class="cell-mono" title="'+esc(j.setup||'')+'">'+esc(shortSetup(j))+'</td>'+
    '<td class="cell-mono" title="'+esc(distanceLabel(j))+'">'+
      esc(distanceLabel(j)==='Remote'?'—':distanceLabel(j))+'</td>'+
    '<td class="cell-mono" title="'+esc(j.posted||'')+'">'+esc(shortPosted(j))+'</td>'+
    '<td class="statuscell"><div class="wrap">'+
      '<select id="'+selId+'" data-url="'+esc(j.url)+
        '" aria-label="Status for '+esc(j.title)+' at '+esc(j.company)+'">'+
        STATUSES.map(function(st){
          return '<option'+(st===j.status?' selected':'')+'>'+esc(st)+'</option>';
        }).join('')+'</select>'+
      '<span class="saved mono" role="status">saved</span>'+
    '</div></td>'+
  '</tr>';

  var detail='<tr class="detail" id="'+id+'"'+(open?'':' hidden')+'><td colspan="8"><div class="inner">'+
    '<p class="meta"><span>'+esc(j.salary||'Salary not posted')+'</span>'+
      '<span>'+esc(j.setup||'—')+'</span>'+
      '<span>'+esc(j.location||'—')+'</span>'+
      (j.industry?'<span>'+esc(j.industry)+'</span>':'')+
      '<span>'+esc(check)+'</span>'+
      '<span>'+esc(inRadius(j))+'</span>'+
      (j.firstSeen?'<span>first seen '+esc(j.firstSeen)+'</span>':'')+'</p>'+
    (j.why?'<p class="why">'+esc(j.why)+'</p>':'')+
    (j.watchOuts?'<p class="watch"><b>Before you apply</b>'+esc(j.watchOuts)+'</p>':'')+
    '<div class="actions">'+
      (j.url?'<a class="open" href="'+esc(j.url)+
        '" target="_blank" rel="noopener">Open listing ↗</a>':'')+
      '<button class="tailorbtn ui" type="button" data-tailor="'+esc(j.url)+'">Tailor résumé</button>'+
    '</div>'+
  '</div></td></tr>';

  return row+detail;
}

function toggleRow(url){
  EXPANDED[url]=!EXPANDED[url];
  renderTable();
}

var STATUS_PATH='job-scout/statuses.json';
var writeQueue=Promise.resolve();

/** The transient indicator beside a status select. */
function flashSaved(sel,text,bad){
  var flag=sel&&sel.parentNode?sel.parentNode.querySelector('.saved'):null;
  if(!flag) return;
  flag.textContent=text||'saved';
  flag.className='saved mono show'+(bad?' bad':'');
  clearTimeout(flag._t);
  flag._t=setTimeout(function(){flag.className='saved mono'+(bad?' bad':'');},1800);
}

function setStatus(url,val,sel){
  var prev=DATA.committedStatuses[url];
  var j=DATA.jobs.filter(function(x){return x.url===url;})[0];
  if(j) j.status=val;
  DATA.committedStatuses[url]=val;

  // Counts only. A full render would replace the <select> she is still holding,
  // taking the focus and the saving indicator with it.
  renderFilters();
  fillExport();

  // The row only has to leave when a status filter no longer matches it, and
  // even then not until the write settles.
  var dropsOut=FILTER!=='all'&&val!==FILTER;

  var map=readStore();
  map[url]=val;
  writeStore(map);

  var token=readToken();
  var slug=repoSlug();
  if(!token||!slug){
    flashSaved(sel,'local only');
    if(dropsOut) setTimeout(render,1400);
    return;
  }

  flashSaved(sel,'saving…');
  var GH=window.JobScoutGitHub;

  // Serialised: two quick changes would otherwise race on the same file sha.
  writeQueue=writeQueue.then(function(){
    return GH.patchJsonMap(token,slug,STATUS_PATH,DATA.branch,url,val,{
      message:'Job Scout: mark '+(j?j.company+' — '+j.title:url)+' as '+val
    }).then(function(){
      flashSaved(sel,'saved');
      if(dropsOut) setTimeout(render,1400);
    },function(err){
      // Put it back rather than showing a status the repository does not have.
      if(prev==null) delete DATA.committedStatuses[url]; else DATA.committedStatuses[url]=prev;
      if(j) j.status=statusFor(j);
      render(); fillExport();
      toast(GH.redact(err.message||String(err),token),true);
    });
  });
  return writeQueue;
}

/**
 * Pulls the committed statuses through the API rather than the published file,
 * which is a Pages deploy behind. Silent on failure — a stale board still works.
 */
function syncStatuses(){
  var token=readToken();
  var slug=repoSlug();
  if(!token||!slug) return Promise.resolve();

  var GH=window.JobScoutGitHub;
  return GH.readJsonFile(token,slug,STATUS_PATH,DATA.branch).then(function(cur){
    if(!cur.data||typeof cur.data!=='object') return;
    DATA.committedStatuses=cur.data;
    DATA.jobs=(DATA.rawJobs||[]).map(function(j){
      var copy=Object.assign({},j);
      copy.status=statusFor(j);
      return copy;
    });
    render(); fillExport();
  },function(){ /* offline or no access — the published copy still renders */ });
}

/**
 * Everything committed is shared between browsers, but the published copies are
 * a Pages deploy behind — so a setting changed on the laptop would not reach the
 * phone for a minute or two, and not at all if that deploy failed. With a token
 * we can read the committed files directly, which makes the three of them agree
 * as soon as the page opens.
 *
 * Silent on failure: a board showing the published copy is still a working board.
 */
function syncFromRepo(){
  var token=readToken();
  var slug=repoSlug();
  if(!token||!slug) return Promise.resolve();

  var GH=window.JobScoutGitHub;

  var settings=GH.readJsonFile(token,slug,CONFIG_PATH,DATA.branch).then(function(cur){
    if(!cur.data||typeof cur.data!=='object'||Array.isArray(cur.data)) return;
    // Do not stamp on edits she is part-way through typing.
    if($('panel').classList.contains('open')) return;
    DATA.config=cur.data;
    fillSettings();
    render(); renderLocals();
  },function(){ /* published copy stands */ });

  // Health and the list it annotates are read together, so a repaired row is
  // never shown against health recorded for the address it used to have.
  var watchlist=Promise.all([
    GH.readJsonFile(token,slug,COMPANIES_PATH,DATA.branch),
    GH.readJsonFile(token,slug,BOARDS_PATH,DATA.branch).then(null,function(){
      return { data:null };
    })
  ]).then(function(res){
    if($('panel').classList.contains('open')) return;
    if(Array.isArray(res[0].data)) DATA.companies=res[0].data;
    if(res[1].data&&typeof res[1].data==='object'){
      DATA.boards=res[1].data.boards||{};
      DATA.boardsChecked=res[1].data.checked||'';
      DATA.lastRun=res[1].data.lastRun||null;
    }
    renderCompanies();
    renderLastRun();
  },function(){ /* published copy stands */ });

  return Promise.all([syncStatuses(),settings,watchlist]);
}

/* ------------------------------------------------------------- locals */

function renderLocals(){
  if(!DATA.locals.length) return;
  $('localWrap').style.display='';
  $('localCount').textContent=DATA.locals.length;
  $('localBody').innerHTML=DATA.locals.map(function(l){
    var d=drivingMiles(l.lat,l.lon,DATA.config);
    var yes=d!=null&&d<=DATA.config.radius;
    var name=l.careers
      ? '<a href="'+esc(l.careers)+'" target="_blank" rel="noopener">'+esc(l.employer)+' ↗</a>'
      : esc(l.employer);
    return '<tr><td>'+name+'</td><td>'+esc(l.city)+
      '</td><td class="mi">'+(d==null?'—':esc(d)+' mi')+'</td><td class="'+(yes?'yes':'no')+'">'+
      (yes?'yes':'no')+'</td><td>'+esc(l.note)+'</td></tr>';
  }).join('');
}

/* ------------------------------------------------------------ refresh */

function setRefreshLabel(text, busy){
  var b=$('refreshBtn');
  b.textContent=text;
  b.disabled=!!busy;
}

/**
 * Starts the workflow and watches it to completion. The Anthropic key stays in
 * the runner — this only presses the button and waits.
 */
function branchOf(token,slug){
  if(DATA.branch) return Promise.resolve(DATA.branch);
  return window.JobScoutGitHub.defaultBranch(token,slug).then(function(b){
    DATA.branch=b;
    return b;
  });
}

function doRefresh(){
  if(REFRESHING) return;

  var token=readToken();
  if(!token){
    openPanel();
    $('ghToken').focus();
    toast('Add a GitHub token to refresh from here.');
    return;
  }

  var slug=repoSlug();
  if(!slug){
    toast('No repository configured. Set "repo" in config.json to owner/name.',true);
    return;
  }

  var GH=window.JobScoutGitHub;
  REFRESHING=true;
  setRefreshLabel('Starting…',true);

  var before=null;

  GH.latestRunId(token,slug)
    .then(function(id){
      before=id;
      return branchOf(token,slug);
    })
    .then(function(branch){
      return GH.dispatch(token,slug,branch);
    })
    .then(function(){
      setRefreshLabel('Searching…',true);
      toast('Search started. This usually takes a couple of minutes.');
      return GH.waitForRun(token,slug,before);
    })
    .then(function(runId){
      if(runId==null){
        // GitHub took the dispatch, so the run exists; it just has not shown up
        // in the run list yet. Saying it never appeared sends her looking for a
        // problem that is not there.
        throw new Error('GitHub started the search but it has not shown up in the run '+
          'list yet. Open View runs in Settings to follow it.');
      }
      return GH.waitForCompletion(token,slug,runId);
    })
    .then(function(run){
      if(run==null){
        toast('Still running. Check View runs in Settings for the outcome.');
        return;
      }
      if(run.conclusion!=='success'){
        // The run records why it stopped before it exits, so the reason is
        // committed by the time the run reports itself complete.
        return syncFromRepo().then(function(){
          var why=DATA.lastRun&&DATA.lastRun.ok===false?DATA.lastRun.reason:'';
          writeLocal(RUN_SEEN,'');
          renderLastRun();
          toast(why||('The run finished as '+run.conclusion+
            '. Check View runs in Settings.'),true);
        });
      }
      setRefreshLabel('Publishing…',true);
      return awaitNewListings();
    })
    .catch(function(err){
      toast(GH.redact(err.message||String(err),token),true);
    })
    .then(function(){
      REFRESHING=false;
      setRefreshLabel('Refresh listings',false);
    });
}

/**
 * The run commits jobs.json, but Pages has to republish before the new file is
 * visible here. Poll for it rather than claiming success too early.
 */
function awaitNewListings(){
  var had=DATA.jobs.length;
  var tries=0;

  function attempt(){
    tries++;
    return getJson('jobs.json?t='+tries,null).then(function(jobs){
      if(jobs&&jobs.length!==had){
        var added=jobs.length-had;
        DATA.jobs=jobs.map(function(j){
          var copy=Object.assign({},j);
          copy.status=statusFor(j);
          return copy;
        });
        render();
        toast(added+(added===1?' new listing':' new listings')+' added.');
        return;
      }
      if(tries>=20){
        toast('Run finished. Nothing new, or the site is still publishing.');
        return;
      }
      return new Promise(function(r){setTimeout(r,6000);}).then(attempt);
    });
  }
  return attempt();
}

/* -------------------------------------------------------------- tailor */

function openTailor(){
  lastFocus=document.activeElement;
  $('tailorPanel').classList.add('open');
  $('scrim').classList.add('open');
  $('tailorPanel').focus();
}

function closeTailor(){
  $('tailorPanel').classList.remove('open');
  if(!$('panel').classList.contains('open')) $('scrim').classList.remove('open');
  if(lastFocus&&lastFocus.focus) lastFocus.focus();
}

function tailorState(msg,bad){
  var el=$('tailorState');
  el.textContent=msg;
  el.className='tstate'+(bad?' bad':'');
  el.hidden=false;
}

function resetTailorPanel(){
  $('tailorOut').hidden=true;
  $('tailorOut').value='';
  $('tailorNotes').hidden=true;
  ['tailorCopy','tailorDownload','tailorRetry'].forEach(function(id){ $(id).hidden=true; });
}

function showTailorResult(result){
  $('tailorOut').value=result.resume;
  $('tailorOut').hidden=false;
  $('tailorCopy').hidden=false;
  $('tailorDownload').hidden=false;
  $('tailorRetry').hidden=false;

  if(result.notes){
    var items=result.notes.split('\n')
      .map(function(l){ return l.replace(/^\s*[-*•]\s*/,'').trim(); })
      .filter(Boolean);
    $('tailorNotes').innerHTML='<h3>What changed and why</h3><ul>'+
      items.map(function(l){ return '<li>'+esc(l)+'</li>'; }).join('')+'</ul>';
    $('tailorNotes').hidden=false;
  }
}

function setTailorButtons(busy){
  Array.prototype.forEach.call(document.querySelectorAll('.tailorbtn'),function(b){
    b.disabled=busy;
    b.textContent=busy?'Tailoring…':'Tailor résumé';
  });
}

/**
 * The one call that leaves the browser directly. The resume and the result stay
 * on this machine - nothing here is committed, because the repository is public.
 */
function doTailor(url){
  var job=DATA.jobs.filter(function(j){return j.url===url;})[0];
  if(!job) return;

  var key=readLocal(ANTH_KEY);
  var resume=readLocal(RESUME_KEY);

  LAST_TAILOR=url;
  resetTailorPanel();
  $('tailorFor').textContent=job.title+' · '+job.company;
  openTailor();

  if(!resume){ tailorState('No résumé saved yet. Add one in Settings → Résumé.',true); return; }
  if(!key){ tailorState('No Anthropic key saved yet. Add one in Settings → Anthropic key.',true); return; }
  if(TAILORING){ tailorState('Another tailoring run is still going. Wait for it to finish.',true); return; }

  TAILORING=true;
  setTailorButtons(true);
  tailorState('Tailoring against this posting… this usually takes under a minute.');

  var R=window.JobScoutResume;
  R.tailor(key,resume,job).then(function(result){
    tailorState('Done. Read the notes before you send it — check every claim against the original.');
    showTailorResult(result);
  },function(err){
    tailorState(R.redact(err.message||String(err),key),true);
    $('tailorRetry').hidden=false;
  }).then(function(){
    TAILORING=false;
    setTailorButtons(false);
  });
}

function copyTailored(){
  var box=$('tailorOut');
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(box.value).then(function(){
      toast('Tailored résumé copied.');
    },function(){ box.focus(); box.select(); toast('Select all and copy.'); });
  }else{ box.focus(); box.select(); toast('Select all and copy.'); }
}

function downloadTailored(){
  var job=DATA.jobs.filter(function(j){return j.url===LAST_TAILOR;})[0];
  var slug=(job?(job.company+'-'+job.title):'resume')
    .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60);
  var blob=new Blob([$('tailorOut').value],{type:'text/markdown;charset=utf-8'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='resume-'+slug+'.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(a.href); },1000);
}

/* ----------------------------------------------------------- settings */

function openPanel(focusId){
  lastFocus=document.activeElement;
  $('panel').classList.add('open');
  $('scrim').classList.add('open');
  if(focusId&&$(focusId)){
    var el=$(focusId);
    // Land on the field that is actually missing, not the top of the panel.
    el.scrollIntoView({block:'center',behavior:prefersReducedMotion()?'auto':'smooth'});
    el.focus({preventScroll:true});
  }else{
    $('panel').focus();
  }
}

function prefersReducedMotion(){
  try{ return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch(err){ return false; }
}

function closePanel(){
  $('panel').classList.remove('open');
  $('scrim').classList.remove('open');
  if(lastFocus&&lastFocus.focus) lastFocus.focus();
}

var CONFIG_PATH='job-scout/config.json';
var CONFIG_FIELDS=['homeLabel','lat','lon','radius','multiplier','minSalary',
                   'titles','industry','workSetup','hardNos'];
var CONFIG_NUMBERS=['lat','lon','radius','multiplier','minSalary'];

function fillSettings(){
  var c=DATA.config;
  CONFIG_FIELDS.forEach(function(k){
    var el=$('s_'+k);
    if(el) el.value=c[k]==null?'':String(c[k]);
  });
  configState('');
  fillExport();
  fillTokenState();
  fillResumeState();
  fillAnthState();
}

/* -------------------------------------------------------------- banner */

var BANNER_KEY = 'jobScout.setupDismissed.v1';

/**
 * A browser that has never been set up looks broken rather than unconfigured:
 * Refresh does nothing useful, statuses do not sync, Tailor refuses. Say so,
 * and put the fix one click away.
 */
function missingSetup(){
  var out=[];
  if(!readToken()){
    out.push({
      key:'token', field:'ghToken', label:'a GitHub token',
      why:'Without it, Refresh listings cannot start a search and status changes stay on this device instead of syncing.'
    });
  }
  if(!readLocal(RESUME_KEY)){
    out.push({ key:'resume', field:'resumeText', label:'a résumé',
      why:'Tailor résumé needs one to work from.' });
  }
  if(!readLocal(ANTH_KEY)){
    out.push({ key:'anth', field:'anthKey', label:'an Anthropic key',
      why:'Tailor résumé needs one to call the API.' });
  }
  return out;
}

function sentence(parts){
  if(parts.length===1) return parts[0];
  if(parts.length===2) return parts[0]+' and '+parts[1];
  return parts.slice(0,-1).join(', ')+', and '+parts[parts.length-1];
}

function renderBanner(){
  var missing=missingSetup();
  var banner=$('setupBanner');

  if(!missing.length){ banner.hidden=true; return; }

  // Dismissal is remembered per set of missing items, so clearing one and
  // leaving another still speaks up, and it never nags about the same thing.
  var signature=missing.map(function(m){return m.key;}).join(',');
  if(readLocal(BANNER_KEY)===signature){ banner.hidden=true; return; }

  var blocking=missing.filter(function(m){return m.key==='token';});
  var first=blocking.length?blocking[0]:missing[0];

  // The setup link only carries the sign-in bits. Once those are in, pasting
  // another one cannot help, so the row goes away and the wording changes.
  var linkHelps=missing.some(function(m){return m.key==='token'||m.key==='anth';});
  $('bannerLinkRow').hidden=!linkHelps;
  if(!linkHelps) bannerError('');

  if(blocking.length){
    $('bannerTitle').textContent='Not set up yet';
    $('bannerBody').textContent=
      'This browser cannot start a search yet, and anything you mark here will not ' +
      'show up on your other devices.';
    $('bannerWhy').textContent=
      'The quick way: on a device where the board already works, open Settings → ' +
      'Set up another browser → Copy setup link, then paste it above. Nothing else to fill in.';
  }else if(linkHelps){
    $('bannerTitle').textContent='Almost there';
    $('bannerBody').textContent=
      'The board is working. Tailor résumé still needs ' +
      sentence(missing.map(function(m){return m.label;}))+'.';
    $('bannerWhy').textContent=
      'A setup link from another device fills in the key. Paste one above, or add it by hand.';
  }else{
    $('bannerTitle').textContent='Almost there';
    $('bannerBody').textContent=
      'The board is working. Tailor résumé needs a résumé to work from.';
    $('bannerWhy').textContent=
      'Paste it in Settings → Résumé. It stays on this device and is never uploaded anywhere but Claude.';
  }

  $('bannerGo').textContent=linkHelps?'No link? Set it up by hand':'Add the résumé';
  $('bannerGo').setAttribute('data-focus',first.field);
  banner.hidden=false;
}

function dismissBanner(){
  var missing=missingSetup();
  writeLocal(BANNER_KEY,missing.map(function(m){return m.key;}).join(','));
  $('setupBanner').hidden=true;
}

/* ----------------------------------------------------------- companies */

var COMPANIES_PATH='job-scout/companies.json';
var BOARDS_PATH='job-scout/boards.json';

function loadCompanies(){
  return Promise.all([
    getJson('companies.json',[]),
    getJson('boards.json',{})
  ]).then(function(res){
    DATA.companies=Array.isArray(res[0])?res[0]:[];
    DATA.boards=(res[1]&&res[1].boards)||{};
    DATA.boardsChecked=(res[1]&&res[1].checked)||'';
    DATA.lastRun=(res[1]&&res[1].lastRun)||null;
    renderCompanies();
    renderLastRun();
  });
}

/**
 * What the last search found when it asked this board for its openings.
 *
 * A board that has gone dead answers 404 and contributes nothing, which looks
 * exactly like a board with no openings — so the answer is recorded by the run
 * and shown here rather than left to be inferred from an empty result.
 */
function healthOf(company){
  var key=window.JobScoutBoards.boardKey(company);
  return (DATA.boards||{})[key]||null;
}

function renderCompanies(){
  var B=window.JobScoutBoards;
  var list=DATA.companies||[];
  var el=$('companyList');

  if(!list.length){
    el.innerHTML='<li class="none">No companies yet — the search still covers the open web.</li>';
    renderBoardSummary(0);
    return;
  }

  el.innerHTML=list.map(function(c,i){
    var url=B.boardUrl(c);
    var name=c.name||B.guessName(c.board);
    // The name is editable because it is what shows in the Company column on
    // the board — a slug like "pomelohealth" guesses to "Pomelohealth", and
    // only a person knows it should read "Pomelo Health".
    var health=healthOf(c);
    var dead=!!health&&health.ok===false;

    var note='';
    if(dead){
      note='<span class="dead" title="'+esc(health.reason||'')+'">'+
        'not answering'+
      '</span>'+
      '<button class="fix ui" type="button" data-fix="'+i+'" '+
        'title="Search for this employer\u2019s current job board">Find it again</button>';
    }else if(health){
      note='<span class="live">'+health.postings+' open</span>';
    }

    return '<li'+(dead?' class="broken"':'')+'>'+
      '<input class="nm" id="cn'+i+'" type="text" value="'+esc(name)+'" data-name="'+i+'" '+
        'aria-label="Company name">'+
      '<span class="via">'+esc(B.label(c.ats))+' · '+
        (url?'<a href="'+esc(url)+'" target="_blank" rel="noopener" title="Open this job board">'+esc(c.board)+'</a>':esc(c.board))+
      '</span>'+
      // Status and buttons travel together, so a narrow panel drops them onto a
      // second line as a unit instead of stranding the remove button alone.
      '<span class="rowend">'+note+
        '<button class="drop ui" type="button" data-drop="'+i+'" '+
          'aria-label="Remove '+esc(name)+'" title="Remove">×</button>'+
      '</span>'+
    '</li>';
  }).join('');

  renderBoardSummary(list.filter(function(c){
    var h=healthOf(c);
    return !!h&&h.ok===false;
  }).length);
}

/* ------------------------------------------------------ last run */

var RUN_SEEN='jobscout.runDismissed';

/**
 * Turns the run's own failure line into the thing to go and do about it.
 *
 * The two that actually happen are a missing secret and a rejected one, and
 * they need different fixes — one is "add it", the other is "the one saved
 * there is wrong". Anything unrecognised is shown verbatim rather than
 * paraphrased into something vaguer than the truth.
 */
function runAdvice(reason){
  var r=String(reason||'');
  if(/is not set/i.test(r)){
    return 'The repository has no Anthropic key saved. In the repository, open '+
      'Settings \u2192 Secrets and variables \u2192 Actions and add one named '+
      'ANTHROPIC_API_KEY.';
  }
  if(/rejected \(401\)|key was rejected/i.test(r)){
    return 'Anthropic refused the key saved in the repository \u2014 it is wrong, '+
      'expired, or was revoked. Make a new one at console.anthropic.com, then '+
      'replace ANTHROPIC_API_KEY under Settings \u2192 Secrets and variables \u2192 '+
      'Actions in the repository.';
  }
  if(/rate limit|\(429\)/i.test(r)){
    return 'Anthropic is rate limiting the key. Wait a few minutes and press '+
      'Refresh listings again.';
  }
  return '';
}

function renderLastRun(){
  var el=$('runBanner');
  var run=DATA.lastRun;
  if(!run||run.ok!==false){ el.hidden=true; return; }

  // Dismissal is per failure, not for good: a new one has to speak up again.
  var stamp=(run.at||'')+'|'+(run.reason||'');
  if(readLocal(RUN_SEEN)===stamp){ el.hidden=true; return; }

  var advice=runAdvice(run.reason);
  $('runBannerBody').textContent=run.reason||'The search stopped without saying why.';
  $('runBannerWhy').textContent=advice||
    'The full log is under View runs in Settings.';
  el.hidden=false;
  el.setAttribute('data-stamp',stamp);
}

/** One line at the top of the list, so a dead board is noticed, not scrolled past. */
function renderBoardSummary(dead){
  var el=$('companySummary');
  if(!dead){ el.hidden=true; el.textContent=''; return; }
  el.hidden=false;
  el.innerHTML='<b>'+dead+' '+(dead===1?'board is':'boards are')+' not answering.</b> '+
    'Those companies contributed nothing to the last search'+
    (DATA.boardsChecked?' on '+esc(DATA.boardsChecked):'')+
    '. Usually the company moved its job board — press <b>Find it again</b> on a '+
    'row to look up where it went, then <b>Save the list</b>.';
}

function companyAddState(msg,bad){
  var el=$('companyAddState');
  el.textContent=msg||'';
  el.className='keystate'+(bad?'':' set');
  el.hidden=!msg;
}

/** Workday is per-tenant, so its entries carry the host as well as the site. */
function entryFor(found,name){
  var e={ name:name, ats:found.ats, board:found.board };
  if(found.host) e.host=found.host;
  return e;
}

/** Puts one company on the list, unless it is already there. */
function pushCompany(entry){
  var already=(DATA.companies||[]).filter(function(c){
    return c.ats===entry.ats&&String(c.board).toLowerCase()===String(entry.board).toLowerCase();
  })[0];
  if(already){
    companyAddState((already.name||entry.board)+' is already on the list.',true);
    return false;
  }
  DATA.companies=(DATA.companies||[]).concat([entry]);
  renderCompanies();
  companyAddState('Added '+entry.name+' — choose Save the list to keep it.');
  return true;
}

var FINDING=false;

/**
 * Takes a job link or just a company name. A link is parsed on the spot; a name
 * has to be looked up, which needs the Anthropic key — finding a Greenhouse
 * address by hand is exactly the chore this is meant to remove.
 */
function addCompany(){
  var B=window.JobScoutBoards;
  var field=$('companyUrl');
  var raw=field.value.trim();
  if(!raw){ companyAddState('Type a company name, or paste a link to a job there.',true); return; }

  var found=B.parseBoardUrl(raw);
  if(found){
    if(pushCompany(entryFor(found,B.guessName(found.board)))){ field.value=''; }
    return;
  }

  // A web address that is not a board we can poll is a dead end, not a name.
  if(/^https?:\/\//i.test(raw)||/\.[a-z]{2,}(\/|$)/i.test(raw)){
    companyAddState('That link is not a Greenhouse, Lever or Ashby job page, so there is '+
      'no page to watch directly. Try typing just the company name instead — '+
      'or leave it out; the web search still covers them.',true);
    return;
  }

  lookUpCompany(raw);
}

function lookUpCompany(name){
  if(FINDING) return;
  var key=readLocal(ANTH_KEY);
  if(!key){
    companyAddState('To find a company by name this needs an Anthropic key — add one '+
      'under Anthropic key below. Or paste a link to a job there instead.',true);
    return;
  }

  FINDING=true;
  $('addCompanyBtn').disabled=true;
  companyAddState('Looking for '+name+"'s job board…");

  var B=window.JobScoutBoards;
  var R=window.JobScoutRefine;

  R.findBoard(key,name,B.parseBoardUrl).then(function(out){
    if(!out.found){
      companyAddState(out.note,true);
      return;
    }
    if(pushCompany(entryFor(out,out.name))){
      $('companyUrl').value='';
      companyAddState('Found '+out.name+' on '+B.label(out.ats)+
        ' — check the link in the list is right, then Save the list.');
    }
  },function(err){
    companyAddState(R.redact(err.message||String(err),key),true);
  }).then(function(){
    FINDING=false;
    $('addCompanyBtn').disabled=false;
  });
}

/**
 * Re-finds the board for a row whose last poll failed, and swaps it in place.
 *
 * Boards move: a company renames its Greenhouse slug, or moves to Workday, and
 * the watchlist entry keeps pointing at nothing. This is the same lookup that
 * adds a company by name, aimed at a row that already exists — so repairing
 * sixteen dead entries is sixteen presses rather than sixteen web searches
 * done by hand.
 */
function repairCompany(i){
  if(FINDING) return;
  var list=DATA.companies||[];
  var c=list[i];
  if(!c) return;

  var key=readLocal(ANTH_KEY);
  if(!key){
    companyState('To look a board up again this needs an Anthropic key — add one '+
      'under Anthropic key below.',true);
    return;
  }

  var name=c.name||window.JobScoutBoards.guessName(c.board);
  FINDING=true;
  companyState('Looking for '+name+"'s job board…");

  var B=window.JobScoutBoards;
  var R=window.JobScoutRefine;

  R.findBoard(key,name,B.parseBoardUrl).then(function(out){
    if(!out.found){
      companyState('Could not find a board for '+name+'. '+(out.note||'')+
        ' You can remove the row — the web search still covers them.',true);
      return;
    }
    var entry=entryFor(out,name);
    if(entry.ats===c.ats&&String(entry.board).toLowerCase()===String(c.board).toLowerCase()){
      companyState('That is the same address as before, so the board really has '+
        'gone. Remove the row — the web search still covers them.',true);
      return;
    }
    DATA.companies=list.slice(0,i).concat([entry],list.slice(i+1));
    renderCompanies();
    companyState('Repointed '+name+' at '+B.label(entry.ats)+'/'+entry.board+
      ' — check the link, then Save the list.');
  },function(err){
    companyState(R.redact(err.message||String(err),key),true);
  }).then(function(){
    FINDING=false;
  });
}

function dropCompany(i){
  var list=DATA.companies||[];
  if(i<0||i>=list.length) return;
  var gone=list[i];
  DATA.companies=list.slice(0,i).concat(list.slice(i+1));
  renderCompanies();
  companyState('Removed '+(gone.name||gone.board)+' — choose Save the list to keep it.');
}

function companyState(msg,bad){
  var el=$('companyState');
  el.textContent=msg||'';
  el.className='keystate'+(bad?'':' set');
  el.hidden=!msg;
}

function saveCompanies(){
  var token=readToken();
  var slug=repoSlug();
  var list=(DATA.companies||[]).filter(function(c){
    if(!c||!c.board||!window.JobScoutBoards.isKnownAts(c.ats)) return false;
    // A Workday entry without its host cannot be polled at all.
    return c.ats!=='workday'||!!c.host;
  });

  if(!token||!slug){
    companyState('Cannot save without a token — this list only matters to the search, '+
      'which reads it from the repository.',true);
    return;
  }

  companyState('Saving…');
  $('saveCompaniesBtn').disabled=true;
  var GH=window.JobScoutGitHub;

  GH.readJsonFile(token,slug,COMPANIES_PATH,DATA.branch).then(function(cur){
    return GH.writeJsonFile(token,slug,COMPANIES_PATH,DATA.branch,list,cur.sha,
      'Job Scout: update the company watchlist').then(function(){
        DATA.companies=list;
        renderCompanies();
        companyState(list.length+' compan'+(list.length===1?'y':'ies')+
          ' saved. The next search checks them.');
        toast('Company list saved.');
      });
  },function(err){
    companyState(GH.redact(err.message||String(err),token),true);
    toast(GH.redact(err.message||String(err),token),true);
  }).then(function(){
    $('saveCompaniesBtn').disabled=false;
  });
}

function revertCompanies(){
  var token=readToken();
  var slug=repoSlug();
  companyAddState('');
  if(!token||!slug){
    return loadCompanies().then(function(){ companyState('Back to the published list.'); });
  }
  companyState('Reloading…');
  window.JobScoutGitHub.readJsonFile(token,slug,COMPANIES_PATH,DATA.branch).then(function(cur){
    if(Array.isArray(cur.data)) DATA.companies=cur.data;
    renderCompanies();
    companyState('Back to what is saved.');
  },function(){
    loadCompanies().then(function(){
      companyState('Could not reach the saved copy; showing the published list.',true);
    });
  });
}

/* --------------------------------------------------- learn from a job */

var LEARNING=false;
var LAST_SUGGESTIONS=[];

function learnState(msg,bad){
  var el=$('learnState');
  el.textContent=msg||'';
  el.className='keystate'+(bad?'':' set');
  el.hidden=!msg;
}

/**
 * Reads a job she likes and proposes settings changes. Nothing is written: the
 * proposals land in the form above, and she still has to press Save.
 */
function learnFromJob(){
  if(LEARNING) return;
  var url=$('learnUrl').value.trim();
  var key=readLocal(ANTH_KEY);

  $('learnResult').hidden=true;
  if(!key){
    learnState('This needs an Anthropic key — add one under Anthropic key below.',true);
    return;
  }
  if(!url){ learnState('Paste a link to the job first.',true); return; }

  LEARNING=true;
  $('learnBtn').disabled=true;
  learnState('Reading the posting… this takes a few seconds.');

  var R=window.JobScoutRefine;
  // Read against the form, not the saved file, so it builds on unsaved edits.
  R.refineFrom(key,url,readConfigForm().config).then(function(out){
    renderSuggestions(out,url);
    learnState('');
  },function(err){
    learnState(R.redact(err.message||String(err),key),true);
  }).then(function(){
    LEARNING=false;
    $('learnBtn').disabled=false;
  });
}

var FIELD_LABELS={
  titles:'Job titles to look for', industry:'Industries',
  workSetup:'Remote, hybrid or on-site', hardNos:'Never show me',
  minSalary:'Lowest salary worth seeing'
};

function renderSuggestions(out,url){
  var B=window.JobScoutBoards;
  LAST_SUGGESTIONS=out.suggestions||[];
  var role=out.role||{};
  var box=$('learnResult');

  var head='<div class="roleline"><b>'+esc(role.title||'That posting')+'</b>'+
    (role.company?' at <b>'+esc(role.company)+'</b>':'')+
    (role.salary?' · '+esc(role.salary):'')+
    (role.setup?' · '+esc(role.setup):'')+
    (role.summary?'<br>'+esc(role.summary):'')+'</div>';

  var body;
  if(!LAST_SUGGESTIONS.length){
    body='<p class="sugg"><span class="none">Your settings already cover this one — '+
      'nothing needs changing.</span></p>';
  }else{
    body='<ul class="sugg">'+LAST_SUGGESTIONS.map(function(s,i){
      var shown=s.field==='minSalary'
        ? '$'+Number(s.value).toLocaleString()
        : (s.action==='replace'?'Replace with: ':'Add: ')+s.value;
      return '<li><input type="checkbox" id="sg'+i+'" data-sugg="'+i+'" checked>'+
        '<label class="what" for="sg'+i+'">'+
          '<span class="field">'+esc(FIELD_LABELS[s.field]||s.field)+'</span>'+
          '<span class="val">'+esc(shown)+'</span>'+
          (s.why?'<span class="why">'+esc(s.why)+'</span>':'')+
        '</label></li>';
    }).join('')+'</ul>'+
    '<button class="panel-btn ui" id="applySuggBtn" type="button" style="margin-left:0">Use the ticked ones</button>';
  }

  // If the link is a board we can poll, offer to watch that employer too.
  var found=B.parseBoardUrl(url);
  var watch='';
  if(found){
    var have=(DATA.companies||[]).some(function(c){
      return c.ats===found.ats&&String(c.board).toLowerCase()===found.board;
    });
    if(!have){
      watch='<p class="hint" style="margin:12px 0 0">'+
        esc(role.company||B.guessName(found.board))+' posts on '+esc(B.label(found.ats))+
        ', so every search could check them directly. '+
        '<button class="linkish ui" id="watchThisBtn" type="button" '+
        'data-ats="'+esc(found.ats)+'" data-board="'+esc(found.board)+'" '+
        (found.host?'data-host="'+esc(found.host)+'" ':'')+
        'data-name="'+esc(role.company||B.guessName(found.board))+'">Add them to the watchlist</button></p>';
    }
  }

  box.innerHTML=head+body+watch;
  box.hidden=false;
}

function applySuggestions(){
  var R=window.JobScoutRefine;
  var picked=Array.prototype.filter.call(
    document.querySelectorAll('#learnResult [data-sugg]'),
    function(cb){ return cb.checked; });

  if(!picked.length){ toast('Tick at least one first.',true); return; }

  // Start from the form so unsaved edits are not thrown away.
  var cfg=readConfigForm().config;
  picked.forEach(function(cb){
    var s=LAST_SUGGESTIONS[Number(cb.getAttribute('data-sugg'))];
    if(s) cfg=R.applySuggestion(cfg,s);
  });

  CONFIG_FIELDS.forEach(function(k){
    var el=$('s_'+k);
    if(el&&cfg[k]!=null) el.value=String(cfg[k]);
  });

  $('learnResult').hidden=true;
  $('learnUrl').value='';
  configState(picked.length+' change'+(picked.length===1?'':'s')+
    ' put into the boxes above. Check them, then Save settings.');
  toast('Applied above — press Save settings to keep them.');
}

function watchThisEmployer(btn){
  var name=btn.getAttribute('data-name');
  var e={ name:name, ats:btn.getAttribute('data-ats'), board:btn.getAttribute('data-board') };
  var host=btn.getAttribute('data-host');
  if(host) e.host=host;
  DATA.companies=(DATA.companies||[]).concat([e]);
  renderCompanies();
  btn.parentNode.innerHTML='Added '+esc(name)+
    ' to the watchlist — press <b>Save the list</b> above to keep it.';
}

/* -------------------------------------------------------------- config */

function configState(msg,bad){
  var el=$('configState');
  el.textContent=msg||'These are the settings the search uses.';
  el.className='keystate'+(bad?'':' set');
  if(bad) el.className='keystate';
}

/** Reads the form back into a config object, validating as it goes. */
function readConfigForm(){
  var next=Object.assign({},DATA.config);
  var problems=[];

  CONFIG_FIELDS.forEach(function(k){
    var el=$('s_'+k);
    if(!el) return;
    var raw=String(el.value||'').trim();

    if(CONFIG_NUMBERS.indexOf(k)===-1){ next[k]=raw; return; }

    if(raw===''){ problems.push(labelFor(k)+' cannot be empty.'); return; }
    var n=Number(raw);
    if(!isFinite(n)){ problems.push(labelFor(k)+' has to be a number.'); return; }
    next[k]=n;
  });

  // Ranges that would silently produce a nonsense board rather than an error.
  if(next.radius!=null&&(next.radius<=0||next.radius>500)) problems.push('Driving distance should be between 1 and 500 miles.');
  if(next.multiplier!=null&&(next.multiplier<1||next.multiplier>3)) problems.push('Road factor should be between 1 and 3.');
  if(next.minSalary!=null&&next.minSalary<0) problems.push('Salary cannot be negative.');
  if(next.lat!=null&&(next.lat<-90||next.lat>90)) problems.push('Latitude should be between -90 and 90.');
  if(next.lon!=null&&(next.lon<-180||next.lon>180)) problems.push('Longitude should be between -180 and 180.');
  if(!String(next.titles||'').trim()) problems.push('Give at least one job title to look for.');

  return { config:next, problems:problems };
}

function labelFor(k){
  return { homeLabel:'Home town', lat:'Latitude', lon:'Longitude',
           radius:'Driving distance', multiplier:'Road factor',
           minSalary:'Salary', titles:'Job titles' }[k]||k;
}

/**
 * Commits config.json, so the board and the next search agree. Read-modify-write
 * on the committed file rather than on what this browser happens to be holding,
 * so a stale tab cannot roll back a change made elsewhere.
 */
function saveConfig(){
  var read=readConfigForm();
  if(read.problems.length){
    configState(read.problems[0],true);
    toast(read.problems[0],true);
    return;
  }

  var token=readToken();
  var slug=repoSlug();

  // Apply locally first — the board should respond even with no token.
  DATA.config=read.config;
  render(); renderLocals();

  if(!token||!slug){
    configState('Changed on this device only — add a token to save it for good.',true);
    toast('Applied here. Without a token it cannot be saved for the next search.',true);
    return;
  }

  configState('Saving…');
  $('saveConfigBtn').disabled=true;
  var GH=window.JobScoutGitHub;

  GH.readJsonFile(token,slug,CONFIG_PATH,DATA.branch).then(function(cur){
    // Keep any keys this page does not know about, such as repo.
    var merged=Object.assign({},cur.data||{},read.config);
    return GH.writeJsonFile(token,slug,CONFIG_PATH,DATA.branch,merged,cur.sha,
      'Job Scout: update search settings').then(function(){
        DATA.config=merged;
        render(); renderLocals();
        configState('Saved. The next search will use these.');
        toast('Settings saved.');
      });
  },function(err){
    configState(GH.redact(err.message||String(err),token),true);
    toast(GH.redact(err.message||String(err),token),true);
  }).then(function(){
    $('saveConfigBtn').disabled=false;
  });
}

/** Throws away edits by re-reading the committed file. */
function revertConfig(){
  var token=readToken();
  var slug=repoSlug();
  if(!token||!slug){
    fillSettings(); render(); renderLocals();
    toast('Put back what the board had loaded.');
    return;
  }
  configState('Reloading…');
  window.JobScoutGitHub.readJsonFile(token,slug,CONFIG_PATH,DATA.branch).then(function(cur){
    if(cur.data) DATA.config=cur.data;
    fillSettings(); render(); renderLocals();
    configState('Back to what is saved.');
    toast('Changes undone.');
  },function(){
    fillSettings();
    configState('Could not reach the saved copy; showing what the board loaded.',true);
  });
}

/**
 * Proves the token works before she finds out the hard way. A token with the
 * wrong permissions otherwise looks fine and then silently fails to save.
 */
function checkToken(){
  var token=readToken();
  var slug=repoSlug();
  var list=$('tokenCheck');

  if(!token){ toast('Save a token first.',true); return; }
  if(!slug){ toast('No repository configured — set "repo" in config.json.',true); return; }

  list.hidden=false;
  list.innerHTML='<li class="wait">Checking…</li>';
  $('checkTokenBtn').disabled=true;

  window.JobScoutGitHub.checkToken(token,slug,STATUS_PATH).then(function(results){
    list.innerHTML=results.map(function(r){
      return '<li class="'+(r.ok?'yes':'no')+'">'+esc(r.label)+
        (r.note?' <span class="note">('+esc(r.note)+')</span>':'')+
        (r.ok?'':'<span class="fix">'+esc(r.fix)+'</span>')+'</li>';
    }).join('');

    var bad=results.filter(function(r){return !r.ok;});
    if(!bad.length){
      list.innerHTML+='<li class="yes">Everything this board needs is working.'+
        '<span class="fix">Saving is only fully proven the first time you change a status, '+
        'but read access on all three checked out.</span></li>';
      toast('Token looks good.');
    }else{
      toast(bad.length+' problem'+(bad.length===1?'':'s')+' with that token — see Settings.',true);
    }
  },function(err){
    list.innerHTML='<li class="no">Could not check the token'+
      '<span class="fix">'+esc(window.JobScoutGitHub.redact(err.message||String(err),token))+'</span></li>';
  }).then(function(){
    $('checkTokenBtn').disabled=false;
  });
}

function fillResumeState(){
  var r=readLocal(RESUME_KEY);
  var el=$('resumeState');
  el.textContent = r
    ? 'Résumé saved in this browser — '+r.trim().split(/\s+/).length+' words.'
    : 'No résumé saved. Tailor will ask for one.';
  el.className='keystate'+(r?' set':'');
  if(r&&!$('resumeText').value) $('resumeText').value=r;
  renderBanner();
}

function saveResume(){
  var v=$('resumeText').value.trim();
  if(!v){ toast('Paste a résumé first.',true); return; }
  if(!writeLocal(RESUME_KEY,v)){
    toast('This browser is blocking site data, so the résumé did not save.',true);
    return;
  }
  fillResumeState();
  toast('Résumé saved to this browser.');
}

function clearResume(){
  writeLocal(RESUME_KEY,'');
  $('resumeText').value='';
  fillResumeState();
  toast('Résumé removed from this browser.');
}

/**
 * pdf.js is 1.7MB, so it is only fetched when a PDF is actually chosen. Kept as
 * a promise so picking a second PDF does not download it twice.
 */
var pdfLib=null;
function loadPdfLib(){
  if(pdfLib) return pdfLib;
  pdfLib=import('./vendor/pdfjs/pdf.min.mjs').then(function(mod){
    var lib=mod.default||mod;
    lib.GlobalWorkerOptions.workerSrc='./vendor/pdfjs/pdf.worker.min.mjs';
    return lib;
  }).catch(function(err){
    pdfLib=null;                              // let a retry try again
    throw new Error('Could not load the PDF reader. '+(err.message||''));
  });
  return pdfLib;
}

function extractPdfText(file){
  return loadPdfLib().then(function(lib){
    return file.arrayBuffer().then(function(buf){
      return lib.getDocument({ data:new Uint8Array(buf) }).promise;
    });
  }).then(function(doc){
    var pages=[];
    for(var i=1;i<=doc.numPages;i++) pages.push(i);
    return pages.reduce(function(chain,n){
      return chain.then(function(acc){
        return doc.getPage(n)
          .then(function(page){ return page.getTextContent(); })
          .then(function(content){
            // Insert a newline where pdf.js reports one, otherwise the whole
            // résumé arrives as a single run-on line.
            var text='';
            content.items.forEach(function(item){
              text+=item.str;
              if(item.hasEOL) text+='\n';
            });
            acc.push(text);
            return acc;
          });
      });
    },Promise.resolve([])).then(function(pages){
      return pages.join('\n\n').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
    });
  });
}

function loadResumeFile(file){
  if(!file) return;
  var isPdf=/\.pdf$/i.test(file.name)||file.type==='application/pdf';

  if(!isPdf){
    var reader=new FileReader();
    reader.onload=function(){
      $('resumeText').value=String(reader.result||'').trim();
      resumeFileState('Read '+file.name+'. Check it below, then Save.');
    };
    reader.onerror=function(){ resumeFileState('Could not read that file.',true); };
    reader.readAsText(file);
    return;
  }

  resumeFileState('Reading '+file.name+'…');
  extractPdfText(file).then(function(text){
    if(!text||text.replace(/\s/g,'').length<40){
      // A scanned résumé is a picture of words, with no text to pull out.
      resumeFileState('That PDF has no text in it — it may be a scan. '+
        'Open it, select all, and paste instead.',true);
      return;
    }
    $('resumeText').value=text;
    resumeFileState('Read '+file.name+' — '+text.trim().split(/\s+/).length+
      ' words. Have a quick look below, then Save.');
  },function(err){
    resumeFileState(err.message||'Could not read that PDF. Try pasting the text instead.',true);
  });
}

function resumeFileState(msg,bad){
  var el=$('resumeFileState');
  el.textContent=msg;
  el.className='keystate'+(bad?'':' set');
  el.hidden=false;
  if(bad) toast(msg,true);
}

function fillAnthState(){
  var has=!!readLocal(ANTH_KEY);
  var el=$('anthState');
  el.textContent = has
    ? 'A key is saved in this browser — Tailor is live.'
    : 'No key saved. Tailor will ask for one.';
  el.className='keystate'+(has?' set':'');
  renderBanner();
}

function saveAnthKey(){
  var f=$('anthKey');
  var v=f.value.trim();
  if(!v){ toast('Paste a key first.',true); return; }
  if(!writeLocal(ANTH_KEY,v)){
    toast('This browser is blocking site data, so the key did not save.',true);
    return;
  }
  f.value='';
  fillAnthState();
  toast('Anthropic key saved.');
}

function clearAnthKey(){
  writeLocal(ANTH_KEY,'');
  $('anthKey').value='';
  fillAnthState();
  toast('Anthropic key removed from this browser.');
}

function fillTokenState(){
  var has=!!readToken();
  var el=$('tokenState');
  el.textContent = has
    ? 'A token is saved in this browser — Refresh listings is live.'
    : 'No token saved. Refresh listings will ask for one.';
  el.className='keystate'+(has?' set':'');
  renderBanner();
}

function saveToken(){
  var f=$('ghToken');
  var v=f.value.trim();
  if(!v){ toast('Paste a token first.',true); return; }
  if(!writeToken(v)){
    toast('This browser is blocking site data, so the token did not save.',true);
    return;
  }
  f.value='';
  fillTokenState();
  toast('Token saved.');
  var slug=repoSlug();
  if(slug) branchOf(v,slug).then(syncFromRepo,function(){ /* reported on first use */ });
}

function clearToken(){
  writeToken('');
  $('ghToken').value='';
  fillTokenState();
  toast('Token removed from this browser.');
}

/* ---------------------------------------------------------- setup link */

/**
 * Credentials cannot live in the repository — GitHub revokes a leaked token
 * within minutes, and while it lives it can rewrite the workflow that holds the
 * Anthropic secret. A URL fragment is the one place a secret can ride safely:
 * everything after the # is never sent to a server, so it reaches no request
 * log, and a bookmark of it rides the browser's own sync between devices.
 */

/*
 * Both credentials are already made of URL-safe characters, so wrapping them in
 * base64 only inflated the link by a third — which meant a denser QR code that
 * stopped decoding when it was scaled down. They go in as they are, separated
 * by a tilde, and each is recognised by its own prefix so no field markers are
 * needed either.
 *
 * Leaving them unencoded also keeps GitHub's secret scanning able to recognise
 * a token if the link is ever pasted somewhere it should not be. Base64 would
 * have hidden it from the one thing that would catch the mistake.
 */

var GH_TOKEN_RE = /^gh[pousr]_|^github_pat_/;
var ANTH_KEY_RE = /^sk-ant-/;

function fromB64Url(s){
  var b64=String(s||'').replace(/-/g,'+').replace(/_/g,'/');
  while(b64.length%4) b64+='=';
  return b64;
}

function buildSetupLink(){
  var parts=[];
  var t=readToken();
  var a=readLocal(ANTH_KEY);
  if(t) parts.push(t);
  if(a) parts.push(a);
  if(!parts.length) return '';

  return location.origin+location.pathname+'#setup='+parts.join('~');
}

/**
 * Draws the setup link as a QR code so a phone can be set up by pointing its
 * camera at the laptop — no typing, no messaging a credential to yourself.
 * Rendered here in the page: the link never goes to a QR service.
 */
function renderSetupQr(){
  var link=buildSetupLink();
  var box=$('setupQr');
  if(!link){ toast('Save a token or a key first — there is nothing to carry over.',true); return; }

  var qr=window.qrcode(0,'L');
  qr.addData(link);
  qr.make();

  var n=qr.getModuleCount();
  var quiet=4;                      // the spec's minimum silent margin
  var size=n+quiet*2;
  var rects='';
  for(var r=0;r<n;r++){
    for(var c=0;c<n;c++){
      if(qr.isDark(r,c)) rects+='<rect x="'+(c+quiet)+'" y="'+(r+quiet)+'" width="1" height="1"/>';
    }
  }

  box.innerHTML='<svg viewBox="0 0 '+size+' '+size+'" role="img" '+
    'aria-label="QR code containing your setup link" shape-rendering="crispEdges">'+
    '<rect width="'+size+'" height="'+size+'" fill="#ffffff"/>'+
    '<g fill="#10231f">'+rects+'</g></svg>';
  box.hidden=false;
  $('setupQrHint').hidden=false;
}

function copySetupLink(){
  var link=buildSetupLink();
  if(!link){ toast('Save a token or a key first — there is nothing to carry over.',true); return; }
  $('setupLink').value=link;
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(link).then(function(){
      toast('Setup link copied. Bookmark it in the other browser.');
    },function(){ revealSetupLink(); });
  }else{ revealSetupLink(); }
}

function revealSetupLink(){
  var link=buildSetupLink();
  if(!link){ toast('Save a token or a key first — there is nothing to carry over.',true); return; }
  var box=$('setupLink');
  box.value=link;
  box.hidden=false;
  box.focus();
  box.select();
}

/**
 * Consumes a #setup= fragment, then strips it from the address bar so the
 * credentials do not sit in the visible URL or in a later share of it.
 */
/**
 * Reads a setup link. Accepts the whole URL, just the fragment, or the bare
 * payload, because what lands in a paste box depends on how it was shared.
 * Returns { ok, saved:[labels] } or { ok:false, reason }.
 */
function readSetupPayload(raw){
  var text=String(raw||'').trim();
  if(!text) return { ok:false, reason:'Paste the setup link first.' };

  var m=/[#&?]setup=([^&\s]+)/.exec(text);
  var encoded=m?m[1]:text;
  try{ encoded=decodeURIComponent(encoded); }catch(err){ /* already decoded */ }

  var payload=null;

  // Current form: the credentials themselves, tilde separated.
  if(GH_TOKEN_RE.test(encoded)||ANTH_KEY_RE.test(encoded)||encoded.indexOf('~')!==-1){
    payload={};
    encoded.split('~').forEach(function(v){
      v=v.trim();
      if(GH_TOKEN_RE.test(v)) payload.t=v;
      else if(ANTH_KEY_RE.test(v)) payload.a=v;
    });
    if(!payload.t&&!payload.a) payload=null;
  }

  // Older links wrapped the same thing in base64'd JSON.
  if(!payload){
    try{
      payload=JSON.parse(window.JobScoutGitHub.b64decode(fromB64Url(encoded)));
    }catch(err){
      return { ok:false, reason:'That does not look like a setup link. Copy it again from the other browser.' };
    }
  }
  if(!payload||typeof payload!=='object'){
    return { ok:false, reason:'That setup link was empty.' };
  }

  var what=[];
  if(payload.t) what.push('a GitHub token');
  if(payload.a) what.push('an Anthropic key');
  if(!what.length) return { ok:false, reason:'That setup link carried nothing.' };

  return { ok:true, payload:payload, labels:what };
}

function saveSetupPayload(payload){
  if(payload.t) writeToken(payload.t);
  if(payload.a) writeLocal(ANTH_KEY,payload.a);
  fillSettings();
}

/** Applies a link the person pasted themselves — the paste is the consent. */
function applyPastedSetupLink(){
  var field=$('bannerLink');
  var res=readSetupPayload(field.value);
  if(!res.ok){ bannerError(res.reason); return; }

  saveSetupPayload(res.payload);
  field.value='';
  bannerError('');
  toast('Done — this browser is set up.');
  if(repoSlug()&&readToken()){
    branchOf(readToken(),repoSlug()).then(syncFromRepo,function(){ /* reported on use */ });
  }
}

function bannerError(msg){
  var el=$('bannerError');
  el.textContent=msg||'';
  el.hidden=!msg;
}

/** Applies a link that was opened rather than pasted, so it must be confirmed. */
function consumeSetupLink(){
  if(!/[#&]setup=/.test(location.hash||'')) return;
  var hash=location.hash;

  // Strip first, so a decode failure still does not leave the secret on screen.
  try{
    history.replaceState(null,'',location.origin+location.pathname+location.search);
  }catch(err){ location.hash=''; }

  var res=readSetupPayload(hash);
  if(!res.ok){ toast(res.reason,true); return; }

  // A link can arrive from anywhere, so never arm a browser silently.
  if(!window.confirm('This link carries '+res.labels.join(' and ')+
      '.\n\nSave to this browser? Only continue if the link is your own.')){
    toast('Setup link ignored. Nothing was saved.');
    return;
  }

  if(res.payload.t) writeToken(res.payload.t);
  if(res.payload.a) writeLocal(ANTH_KEY,res.payload.a);
  toast('Saved '+res.labels.join(' and ')+' to this browser.');
}

function fillExport(){
  var map=Object.assign({},DATA.committedStatuses);
  Object.keys(map).forEach(function(k){
    if(map[k]==='Not started') delete map[k];
  });

  $('exportBox').value=JSON.stringify(map,null,2);

  var n=Object.keys(map).length;
  var synced=!!(readToken()&&repoSlug());
  var st=$('statusState');
  st.textContent = synced
    ? (n?n+' status'+(n===1?'':'es')+' synced across browsers.':'No statuses set yet. Changes will sync across browsers.')
    : (n?n+' status'+(n===1?'':'es')+' saved on this device only.':'No statuses set yet. Add a token to sync them across browsers.');
  st.className='keystate'+(synced?' set':'');
}

function copyExport(){
  var box=$('exportBox');
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(box.value).then(function(){
      toast('Status JSON copied.');
    },function(){ selectFallback(box); });
  }else{
    selectFallback(box);
  }
}

function selectFallback(box){
  box.focus();
  box.select();
  toast('Select all and copy — the clipboard is unavailable here.');
}

function clearStatuses(){
  try{ localStorage.removeItem(STORE_KEY); }catch(err){ /* nothing to clear */ }
  DATA.jobs.forEach(function(j){ j.status=statusFor(j); });
  render(); fillExport();
  toast('Local copy cleared. Committed statuses are untouched.');
  return syncStatuses();
}

/* --------------------------------------------------------------- wire */

$('refreshBtn').addEventListener('click',doRefresh);
$('clearTokenBtn').addEventListener('click',clearToken);
$('setupQrBtn').addEventListener('click',renderSetupQr);
$('setupLinkBtn').addEventListener('click',copySetupLink);
$('bannerGo').addEventListener('click',function(e){
  openPanel(e.currentTarget.getAttribute('data-focus'));
});
$('bannerDismiss').addEventListener('click',dismissBanner);
$('checkTokenBtn').addEventListener('click',checkToken);
$('saveConfigBtn').addEventListener('click',saveConfig);
$('learnBtn').addEventListener('click',learnFromJob);
$('learnUrl').addEventListener('keydown',function(e){
  if(e.key==='Enter'){ e.preventDefault(); learnFromJob(); }
});
$('learnResult').addEventListener('click',function(e){
  if(e.target.id==='applySuggBtn') applySuggestions();
  if(e.target.id==='watchThisBtn') watchThisEmployer(e.target);
});
$('addCompanyBtn').addEventListener('click',addCompany);
$('saveCompaniesBtn').addEventListener('click',saveCompanies);
$('revertCompaniesBtn').addEventListener('click',revertCompanies);
$('companyUrl').addEventListener('keydown',function(e){
  if(e.key==='Enter'){ e.preventDefault(); addCompany(); }
});
$('runBannerDismiss').addEventListener('click',function(){
  writeLocal(RUN_SEEN,$('runBanner').getAttribute('data-stamp')||'');
  $('runBanner').hidden=true;
});

$('companyList').addEventListener('click',function(e){
  var fix=e.target.closest('[data-fix]');
  if(fix){ repairCompany(Number(fix.getAttribute('data-fix'))); return; }
  var btn=e.target.closest('[data-drop]');
  if(btn) dropCompany(Number(btn.getAttribute('data-drop')));
});
// Typed straight into DATA rather than re-rendering, so the field keeps focus.
$('companyList').addEventListener('input',function(e){
  var i=e.target.getAttribute('data-name');
  if(i==null) return;
  var c=(DATA.companies||[])[Number(i)];
  if(c){ c.name=e.target.value; companyState('Edited — choose Save the list to keep it.'); }
});
$('revertConfigBtn').addEventListener('click',revertConfig);
$('bannerApply').addEventListener('click',applyPastedSetupLink);
$('bannerLink').addEventListener('keydown',function(e){
  if(e.key==='Enter'){ e.preventDefault(); applyPastedSetupLink(); }
});

// Getting the link into the box is the whole interaction, so finish the job as
// soon as the text makes sense. Watching `input` rather than `paste` covers
// autofill, drag-and-drop and typing too — and staying silent until it parses
// means half-typed text never produces an error.
var bannerLinkTimer=null;
$('bannerLink').addEventListener('input',function(){
  bannerError('');
  clearTimeout(bannerLinkTimer);
  bannerLinkTimer=setTimeout(function(){
    if(readSetupPayload($('bannerLink').value).ok) applyPastedSetupLink();
  },250);
});
$('setupRevealBtn').addEventListener('click',revealSetupLink);

// Submit rather than click, so the browser's password manager sees a real
// credential submission and offers to save it — that is the other half of
// getting these onto a second machine without retyping.
$('ghForm').addEventListener('submit',function(e){ e.preventDefault(); saveToken(); });
$('anthForm').addEventListener('submit',function(e){ e.preventDefault(); saveAnthKey(); });
$('settingsBtn').addEventListener('click',openPanel);
$('closeBtn').addEventListener('click',closePanel);
$('scrim').addEventListener('click',function(){
  if($('tailorPanel').classList.contains('open')) closeTailor();
  if($('panel').classList.contains('open')) closePanel();
});
$('copyBtn').addEventListener('click',copyExport);
$('clearBtn').addEventListener('click',clearStatuses);

$('filters').addEventListener('click',function(e){
  var btn=e.target.closest('[data-filter]');
  if(btn) setFilter(btn.getAttribute('data-filter'));
});

/* ------------------------------------------------------------- tailor */

$('saveResumeBtn').addEventListener('click',saveResume);
$('clearResumeBtn').addEventListener('click',clearResume);
$('resumeFile').addEventListener('change',function(e){ loadResumeFile(e.target.files[0]); });
$('clearAnthBtn').addEventListener('click',clearAnthKey);
$('tailorClose').addEventListener('click',closeTailor);
$('tailorCopy').addEventListener('click',copyTailored);
$('tailorDownload').addEventListener('click',downloadTailored);
$('tailorRetry').addEventListener('click',function(){ if(LAST_TAILOR) doTailor(LAST_TAILOR); });

document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-tailor]');
  if(btn) doTailor(btn.getAttribute('data-tailor'));
});

/* ------------------------------------------------------- view + filters */

var searchTimer=null;
$('search').addEventListener('input',function(e){
  var v=e.target.value;
  clearTimeout(searchTimer);
  searchTimer=setTimeout(function(){ setQuery(v); },160);
});

$('search').addEventListener('keydown',function(e){
  if(e.key==='Escape'&&e.target.value){
    e.stopPropagation();
    e.target.value='';
    setQuery('');
  }
});

$('onlyFilters').addEventListener('change',function(e){
  var key=e.target.getAttribute('data-only');
  if(key) setOnly(key,e.target.checked);
});

$('clearFilters').addEventListener('click',clearAllFilters);

$('tableView').addEventListener('click',function(e){
  var sortBtn=e.target.closest('[data-sort]');
  if(sortBtn){ setSort(sortBtn.getAttribute('data-sort')); return; }
  var toggle=e.target.closest('[data-toggle]');
  if(toggle){ toggleRow(toggle.getAttribute('data-toggle')); }
});

$('tableView').addEventListener('change',function(e){
  if(e.target.tagName==='SELECT'){
    setStatus(e.target.getAttribute('data-url'),e.target.value,e.target);
  }
});

document.addEventListener('keydown',function(e){
  if(e.key!=='Escape') return;
  // Innermost first: the tailor drawer can be opened from over the settings one.
  if($('tailorPanel').classList.contains('open')) closeTailor();
  else if($('panel').classList.contains('open')) closePanel();
});

// Before load, so a browser arriving via a setup link is already armed and can
// read the committed statuses on its very first render.
consumeSetupLink();

load();
