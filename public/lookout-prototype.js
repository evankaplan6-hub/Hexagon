/* Concept A fixture controller. Deliberately no network calls. */
(() => {
  'use strict';
  const scene=document.getElementById('scene');
  const curtain=document.getElementById('curtain');
  const event=document.getElementById('event');
  const states={
    busy:{pnl:'−$84.12',equity:'$9,915.88',positions:'28',locked:'+$14.71',maker:'−$11.04',quotes:'24',inventory:'1,619',fills:'424',status:'Working',brief:'Seven desks working',detail:'Scanning 319 matched markets · paper account',agent:'MAKR',message:'Quoting both sides in 24 markets'},
    quiet:{pnl:'−$84.12',equity:'$9,915.88',positions:'28',locked:'+$14.71',maker:'−$11.04',quotes:'0',inventory:'1,619',fills:'424',status:'Monitoring',brief:'No trade qualifies',detail:'Quotes fresh · risk checks clear · paper account',agent:'TESS',message:'All clear. Waiting for a genuine edge.'},
    fill:{pnl:'−$82.94',equity:'$9,917.06',positions:'28',locked:'+$14.71',maker:'−$9.86',quotes:'24',inventory:'1,629',fills:'425',status:'Fill received',brief:'Maker inventory changed',detail:'Bought 10 at 26¢ · risk checks clear',agent:'MAKR',message:'Bought 10 contracts at 26¢'},
    halt:{pnl:'−$126.31',equity:'$9,873.69',positions:'28',locked:'+$14.71',maker:'−$18.20',quotes:'0',inventory:'1,629',fills:'425',status:'Stopped',brief:'New risk disabled',detail:'Open positions remain monitored',agent:'TESS',message:'Drawdown rail reached. New risk is halted.'},
    stale:{pnl:'−$84.12',equity:'$9,915.88',positions:'28',locked:'+$14.71',maker:'−$11.04',quotes:'—',inventory:'—',fills:'—',status:'No signal',brief:'The floor went quiet',detail:'Last desk frame was more than 12 seconds ago',agent:'SYSTEM',message:'The live stream stopped.'}
  };
  const $=(id)=>document.getElementById(id);
  function setState(name){
    const s=states[name];scene.className=`scene ${name}`;
    for(const id of ['pnl','equity','positions','locked','maker','quotes','inventory','fills']) $(id).textContent=s[id];
    $('deskStatus').textContent=s.status;$('brief').textContent=s.brief;$('detail').textContent=s.detail;
    event.querySelector('b').textContent=s.agent;event.querySelector('span').textContent=s.message;
    curtain.hidden=name!=='stale'&&name!=='halt';
    if(name==='halt'){$('curtainTitle').textContent='THE DESK IS STOPPED';$('curtainText').textContent='New risk is disabled. Open positions remain monitored.'}
    else{$('curtainTitle').textContent='THE FLOOR WENT QUIET';$('curtainText').textContent='No new frame from the desk. The scene would stop here.'}
    document.querySelectorAll('nav button').forEach((b)=>b.classList.toggle('on',b.dataset.state===name));
    document.querySelectorAll('.agent').forEach((a)=>a.classList.toggle('active',name==='busy'||name==='fill'||(name==='quiet'&&a.dataset.agent==='MAKR')));
  }
  document.querySelector('nav').addEventListener('click',(e)=>{const b=e.target.closest('button[data-state]');if(b)setState(b.dataset.state)});
  document.querySelectorAll('.agent').forEach((a)=>a.addEventListener('click',()=>{document.querySelectorAll('.agent').forEach((x)=>x.classList.remove('focus'));a.classList.add('focus')}));
  setState('busy');
})();
