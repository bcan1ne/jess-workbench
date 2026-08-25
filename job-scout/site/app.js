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

var DATA = { jobs: [], locals: [], config: {}, committedStatuses: {} };
var FILTER = 'all';
var STORE_KEY = 'jobScout.statuses.v1';
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

/** Committed statuses are the floor; anything set in this browser wins. */
function statusFor(job){
  var local=readStore();
  if(local[job.url]) return local[job.url];
  if(DATA.committedStatuses[job.url]) return DATA.committedStatuses[job.url];
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
  var host=location.hostname;
  var owner=host.indexOf('.github.io')>0?host.split('.')[0]:null;
  var seg=location.pathname.split('/').filter(Boolean);
  if(owner&&seg.length) return owner+'/'+seg[0];
  return null;
}

function wireLinks(){
  var slug=repoSlug();
  var run=$('runLink');
  var cfgLink=$('configLink');
  if(slug){
    run.href='https://github.com/'+slug+'/actions/workflows/job-scout.yml';
    cfgLink.href='https://github.com/'+slug+'/blob/HEAD/job-scout/config.json';
  }else{
    run.href='https://github.com';
    cfgLink.href='https://github.com';
  }
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
    // statusFor reads committedStatuses, so resolve only once it is in place.
    DATA.jobs=(res[1]||[]).map(function(j){
      var copy=Object.assign({},j);
      copy.status=statusFor(j);
      return copy;
    });
    wireLinks();
    renderFilters(); renderBoard(); renderLocals(); fillSettings();
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

function setStatus(url,val,sel){
  var flag=sel.parentNode.querySelector('.saved');
  var map=readStore();
  map[url]=val;

  if(!writeStore(map)){
    toast('This browser is blocking site data, so the status did not save.',true);
    return;
  }

  var j=DATA.jobs.filter(function(x){return x.url===url;})[0];
  if(j) j.status=val;
  flag.className='saved mono show';
  setTimeout(function(){flag.className='saved mono';},1500);
  renderFilters();
  fillExport();
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
}

function fillExport(){
  var local=readStore();
  var merged=Object.assign({},DATA.committedStatuses,local);
  Object.keys(merged).forEach(function(k){
    if(merged[k]==='Not started') delete merged[k];
  });

  $('exportBox').value=JSON.stringify(merged,null,2);

  var n=Object.keys(local).length;
  var st=$('statusState');
  st.textContent = n
    ? n+' status change'+(n===1?'':'s')+' saved in this browser.'
    : 'No status changes in this browser yet.';
  st.className='keystate'+(n?' set':'');
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
  toast('This browser is back to the committed statuses.');
}

/* --------------------------------------------------------------- wire */

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
