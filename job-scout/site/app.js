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
var TOKEN_KEY = 'jobScout.ghToken.v1';
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
    renderFilters(); renderBoard(); renderLocals(); fillSettings();
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

function renderFilters(){
  var counts={all:DATA.jobs.length};
  STATUSES.forEach(function(s){
    counts[s]=DATA.jobs.filter(function(j){return j.status===s;}).length;
  });
  var opts=[{k:'all',t:'Everything'}].concat(
    STATUSES.filter(function(s){return counts[s]>0||s==='Not started';})
            .map(function(s){return {k:s,t:s};}));
  $('filters').innerHTML=opts.map(function(o){
    return '<button class="chip" type="button" aria-pressed="'+(FILTER===o.k)+
      '" data-filter="'+esc(o.k)+'">'+esc(o.t)+
      '<span class="n">'+(counts[o.k]||0)+'</span></button>';
  }).join('');

  var n=DATA.jobs.filter(function(j){return j.fit>=8;}).length;
  $('railFoot').textContent=DATA.jobs.length+' listings tracked · '+n+' in the top band';
}

function setFilter(k){ FILTER=k; renderFilters(); renderBoard(); }

/* -------------------------------------------------------------- board */

function renderBoard(){
  var jobs=DATA.jobs.filter(function(j){return FILTER==='all'||j.status===FILTER;});
  var el=$('board');

  if(!jobs.length){
    el.innerHTML='<div class="empty"><h3>Nothing here yet</h3><p>'+
      (DATA.jobs.length?'No listings under this filter. Choose Everything to see the full board.'
                       :'No listings on the board yet. Use Run a search in the sidebar to start one.')+
      '</p></div>';
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
  var sel='<label class="vh" for="'+selId+'">Status for '+esc(j.title)+' at '+esc(j.company)+'</label>'+
    '<select id="'+selId+'" data-url="'+esc(j.url)+'">'+
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
function setStatus(url,val,sel){
  var prev=DATA.committedStatuses[url];
  var j=DATA.jobs.filter(function(x){return x.url===url;})[0];
  if(j) j.status=val;
  DATA.committedStatuses[url]=val;
  renderFilters();
  fillExport();

  var map=readStore();
  map[url]=val;
  writeStore(map);

  var token=readToken();
  var slug=repoSlug();
  if(!token||!slug){
    flashSaved(sel,'this browser only');
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
    },function(err){
      // Put it back rather than showing a status the repository does not have.
      if(prev==null) delete DATA.committedStatuses[url]; else DATA.committedStatuses[url]=prev;
      if(j) j.status=statusFor(j);
      renderFilters(); renderBoard(); fillExport();
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
    renderFilters(); renderBoard(); fillExport();
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
        renderFilters(); renderBoard();
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
  renderFilters(); renderBoard(); fillExport();
  toast('Local copy cleared. Committed statuses are untouched.');
  return syncStatuses();
}

/* --------------------------------------------------------------- wire */

$('refreshBtn').addEventListener('click',doRefresh);
$('saveTokenBtn').addEventListener('click',saveToken);
$('clearTokenBtn').addEventListener('click',clearToken);
$('settingsBtn').addEventListener('click',openPanel);
$('closeBtn').addEventListener('click',closePanel);
$('scrim').addEventListener('click',closePanel);
$('copyBtn').addEventListener('click',copyExport);
$('clearBtn').addEventListener('click',clearStatuses);
$('exportBtn').addEventListener('click',function(){ openPanel(); copyExport(); });

$('filters').addEventListener('click',function(e){
  var btn=e.target.closest('[data-filter]');
  if(btn) setFilter(btn.getAttribute('data-filter'));
});

$('board').addEventListener('change',function(e){
  if(e.target.tagName==='SELECT'){
    setStatus(e.target.getAttribute('data-url'),e.target.value,e.target);
  }
});

document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&$('panel').classList.contains('open')) closePanel();
});

load();
