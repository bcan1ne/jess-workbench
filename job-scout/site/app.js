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

var DATA = { jobs: [], rawJobs: [], locals: [], config: {}, committedStatuses: {}, branch: null };
var FILTER = 'all';
var STORE_KEY = 'jobScout.statuses.v1';
var VIEW_KEY = 'jobScout.view.v1';
var VIEW = 'cards';
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
    render(); renderLocals(); fillSettings();
    // The published statuses.json lags a Pages deploy behind. With a token,
    // re-read the committed file directly so every browser agrees right away.
    return syncStatuses();
  }).catch(function(err){
    $('board').innerHTML=
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

/** Re-renders whichever view is showing, plus the counts around it. */
function render(){
  renderFilters();
  if(VIEW==='table') renderTable(); else renderBoard();
}

function renderBoard(){
  var jobs=visibleJobs();
  var el=$('board');

  if(!jobs.length){
    el.innerHTML=emptyMessage();
    return;
  }

  var html='',i=0;
  BANDS.forEach(function(band){
    var inBand=jobs.filter(band.test);
    if(!inBand.length) return;
    html+='<div class="band-head"><h2 style="color:'+band.tone+'">'+esc(band.label)+
          '</h2><span class="desc">'+esc(band.desc)+'</span><span class="count">'+
          inBand.length+'</span></div>';
    inBand.forEach(function(j){ html+=card(j,band,i++); });
  });
  el.innerHTML=html;
}

function card(j,band,i){
  var ticks='';
  for(var t=10;t>=1;t--) ticks+='<span class="tick'+(t<=j.fit?' on':'')+'"></span>';

  var check=salaryCheck(j);
  var salCls = check==='Below floor' ? ' warn'
             : check==='Clears floor' ? ' good' : '';

  var facts=[
    ['Salary', j.salary||'—', salCls],
    ['Setup',  j.setup||'—', ''],
    ['Where',  j.location||'—', ''],
    ['Drive',  distanceLabel(j), ''],
    ['Posted', j.posted||'—', '']
  ].map(function(f){
    return '<div class="fact"><span class="k">'+f[0]+'</span><span class="v'+f[2]+'">'+esc(f[1])+'</span></div>';
  }).join('');

  var selId='st'+i;
  var sel='<select id="'+selId+'" data-url="'+esc(j.url)+
    '" aria-label="Status for '+esc(j.title)+' at '+esc(j.company)+'">'+
    STATUSES.map(function(s){
      return '<option'+(s===j.status?' selected':'')+'>'+esc(s)+'</option>';
    }).join('')+'</select>';

  return '<article class="card" style="--tone:'+band.tone+';animation-delay:'+(i*34)+'ms">'+
    '<div class="gauge"><span class="num">'+esc(j.fit)+'</span>'+
      '<span class="scale" role="img" aria-label="Fit '+esc(j.fit)+' out of 10">'+ticks+'</span>'+
      '<span class="cap">fit</span></div>'+
    '<div class="body">'+
      '<div class="titleline"><h3>'+esc(j.title)+'</h3><span class="co">'+esc(j.company)+'</span></div>'+
      '<div class="strip">'+facts+'</div>'+
      (j.why?'<p class="why">'+esc(j.why)+'</p>':'')+
      (j.watchOuts?'<p class="watch"><b>Before you apply</b>'+esc(j.watchOuts)+'</p>':'')+
      '<div class="actions">'+
        (j.url?'<a class="open" href="'+esc(j.url)+'" target="_blank" rel="noopener">Open listing ↗</a>':'')+
        sel+'<span class="saved mono" role="status">saved</span>'+
        '<button class="tailorbtn ui" type="button" data-tailor="'+esc(j.url)+'">Tailor résumé</button>'+
      '</div>'+
    '</div></article>';
}

var STATUS_PATH='job-scout/statuses.json';
var writeQueue=Promise.resolve();

function flashSaved(sel,text,bad){
  var flag=sel&&sel.parentNode?sel.parentNode.querySelector('.saved'):null;
  if(!flag) return;
  flag.textContent=text||'saved';
  flag.className='saved mono show'+(bad?' bad':'');
  clearTimeout(flag._t);
  flag._t=setTimeout(function(){flag.className='saved mono'+(bad?' bad':'');},1800);
}

/**
 * Optimistic locally, then committed to the repository so the change shows up
 * on every other browser. Without a token there is nothing to sync to, so it
 * falls back to this browser only and says so.
 */
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
    '<td><span class="fitcell">'+esc(j.fit)+'</span></td>'+
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

function setView(v){
  VIEW=v;
  try{ localStorage.setItem(VIEW_KEY,v); }catch(err){ /* preference only */ }
  $('board').hidden = v==='table';
  $('tableView').hidden = v!=='table';
  $('lede').textContent = v==='table'
    ? 'Every listing in one place. Sort by any column, and open a title to read the full note.'
    : 'Listings are grouped by how closely they match the résumé. Work top down — the first band is where the odds are best.';
  Array.prototype.forEach.call($('viewToggle').querySelectorAll('button'),function(b){
    b.setAttribute('aria-pressed', String(b.getAttribute('data-view')===v));
  });
  render();
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
        throw new Error('The run did not appear. Check View runs in Settings.');
      }
      return GH.waitForCompletion(token,slug,runId);
    })
    .then(function(run){
      if(run==null){
        toast('Still running. Check View runs in Settings for the outcome.');
        return;
      }
      if(run.conclusion!=='success'){
        toast('The run finished as '+run.conclusion+'. Check View runs in Settings.',true);
        return;
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

function openPanel(){
  lastFocus=document.activeElement;
  $('panel').classList.add('open');
  $('scrim').classList.add('open');
  $('panel').focus();
}

function closePanel(){
  $('panel').classList.remove('open');
  $('scrim').classList.remove('open');
  if(lastFocus&&lastFocus.focus) lastFocus.focus();
}

function fillSettings(){
  var c=DATA.config;
  [['homeLabel',c.homeLabel],['lat',c.lat],['lon',c.lon],['radius',c.radius],
   ['multiplier',c.multiplier],['minSalary',c.minSalary],['titles',c.titles],
   ['industry',c.industry],['workSetup',c.workSetup],['hardNos',c.hardNos]
  ].forEach(function(p){
    var el=$('s_'+p[0]);
    if(el) el.textContent=p[1]==null?'—':String(p[1]);
  });
  fillExport();
  fillTokenState();
  fillResumeState();
  fillAnthState();
}

function fillResumeState(){
  var r=readLocal(RESUME_KEY);
  var el=$('resumeState');
  el.textContent = r
    ? 'Résumé saved in this browser — '+r.trim().split(/\s+/).length+' words.'
    : 'No résumé saved. Tailor will ask for one.';
  el.className='keystate'+(r?' set':'');
  if(r&&!$('resumeText').value) $('resumeText').value=r;
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

function loadResumeFile(file){
  if(!file) return;
  var reader=new FileReader();
  reader.onload=function(){
    $('resumeText').value=String(reader.result||'').trim();
    toast('Loaded '+file.name+'. Choose Save résumé to keep it.');
  };
  reader.onerror=function(){ toast('Could not read that file.',true); };
  reader.readAsText(file);
}

function fillAnthState(){
  var has=!!readLocal(ANTH_KEY);
  var el=$('anthState');
  el.textContent = has
    ? 'A key is saved in this browser — Tailor is live.'
    : 'No key saved. Tailor will ask for one.';
  el.className='keystate'+(has?' set':'');
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
  if(slug) branchOf(v,slug).then(syncStatuses,function(){ /* reported on first use */ });
}

function clearToken(){
  writeToken('');
  $('ghToken').value='';
  fillTokenState();
  toast('Token removed from this browser.');
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
$('saveTokenBtn').addEventListener('click',saveToken);
$('clearTokenBtn').addEventListener('click',clearToken);
$('settingsBtn').addEventListener('click',openPanel);
$('closeBtn').addEventListener('click',closePanel);
$('scrim').addEventListener('click',function(){
  if($('tailorPanel').classList.contains('open')) closeTailor();
  if($('panel').classList.contains('open')) closePanel();
});
$('copyBtn').addEventListener('click',copyExport);
$('clearBtn').addEventListener('click',clearStatuses);
$('exportBtn').addEventListener('click',function(){ openPanel(); copyExport(); });

$('filters').addEventListener('click',function(e){
  var btn=e.target.closest('[data-filter]');
  if(btn) setFilter(btn.getAttribute('data-filter'));
});

/* ------------------------------------------------------------- tailor */

$('saveResumeBtn').addEventListener('click',saveResume);
$('clearResumeBtn').addEventListener('click',clearResume);
$('resumeFile').addEventListener('change',function(e){ loadResumeFile(e.target.files[0]); });
$('saveAnthBtn').addEventListener('click',saveAnthKey);
$('clearAnthBtn').addEventListener('click',clearAnthKey);
$('tailorClose').addEventListener('click',closeTailor);
$('tailorCopy').addEventListener('click',copyTailored);
$('tailorDownload').addEventListener('click',downloadTailored);
$('tailorRetry').addEventListener('click',function(){ if(LAST_TAILOR) doTailor(LAST_TAILOR); });

document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-tailor]');
  if(btn) doTailor(btn.getAttribute('data-tailor'));
});

$('board').addEventListener('change',function(e){
  if(e.target.tagName==='SELECT'){
    setStatus(e.target.getAttribute('data-url'),e.target.value,e.target);
  }
});

/* ------------------------------------------------------- view + filters */

$('viewToggle').addEventListener('click',function(e){
  var btn=e.target.closest('[data-view]');
  if(btn) setView(btn.getAttribute('data-view'));
});

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

try{
  var saved=localStorage.getItem(VIEW_KEY);
  if(saved==='table'||saved==='cards') VIEW=saved;
}catch(err){ /* default to cards */ }
setView(VIEW);

load();
