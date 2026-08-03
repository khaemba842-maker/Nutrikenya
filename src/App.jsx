import { supabase } from './supabase'
import { logError } from './errorLog'
import { queueWrite, cancelQueued, registerHandler, installOnlineFlush, queueLength, onQueueChange } from './offlineQueue'
import { pushSupported, getPushSubscription, subscribeToPush, unsubscribeFromPush } from './push'
import { track, identifyUser, resetAnalytics } from './analytics'
import { useState, useRef, useEffect } from "react";

const BG='#070707',C1='#0D0D0D',C2='#141414',C3='#1C1C1C',C4='#252525';
const W='#FFFFFF',W2='#7A7A7A',W3='#404040';
const BD='rgba(255,255,255,0.06)',BD2='rgba(255,255,255,0.13)';
const FF=`-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
const REST_GROUPS=['All','Fast Food','Kenyan & African','Casual Dining','Grills & Steakhouse','Fine Dining','Modern & Trendy'];

const QS=[
  {id:'name',q:"What should we call you?",qs:"Jina lako nani?",type:'text',ph:'Your name'},
  {id:'age',q:"How old are you?",qs:"Una miaka mingapi?",type:'number',ph:'25',unit:'years'},
  {id:'sex',q:"Biological sex?",qs:"Jinsia yako ya kibiolojia?",type:'opts',opts:['Male','Female'],sw:['Mume','Mke']},
  {id:'weight',q:"Current weight?",qs:"Uzito wako wa sasa?",type:'number',ph:'70',unit:'kg'},
  {id:'height',q:"Your height?",qs:"Urefu wako?",type:'height'},
  {id:'goal',q:"Main goal?",qs:"Lengo lako kuu ni nini?",type:'opts',opts:['Lose Fat','Build Muscle','Body Recomp','Maintain'],sw:['Kupunguza Mafuta','Kujenga Misuli','Kubadilisha Mwili','Kudumisha']},
  {id:'targetWeight',q:"Target weight?",qs:"Uzito unaolengwa?",type:'number',ph:'70',unit:'kg'},
  {id:'activity',q:"How active are you daily?",qs:"Maisha yako ni ya nguvu kiasi gani?",type:'opts',
    opts:['Sedentary — desk job','Lightly Active — occasional walks','Moderately Active — gym 3–4x/week','Very Active — training 5–6x/week','Extremely Active — athlete / manual labor'],
    sw:['Wastani — kazi ya ofisi','Hai Kidogo — matembezi','Hai Wastani — mazoezi 3–4x','Hai Sana — mafunzo 5–6x','Hai Sana Kupita Kiasi']},
  {id:'workoutDays',q:"Training days per week?",qs:"Unafanya mazoezi siku ngapi kwa wiki?",type:'number',ph:'4',unit:'days/week'},
  {id:'workoutType',q:"Type of training?",qs:"Unafanya aina gani ya mazoezi?",type:'opts',
    opts:['Weight Training','Cardio — running, cycling','Mixed — weights + cardio','Sports — football, basketball','Just Starting Out'],
    sw:['Uzito','Mazoezi ya Moyo','Mseto','Michezo','Ninaanza Tu']},
  {id:'restrictions',q:"Dietary restrictions?",qs:"Una vikwazo vyovyote vya lishe?",type:'opts',opts:['None','Halal','Vegetarian','Vegan','Lactose Free'],sw:['Hakuna','Halali','Mboga tu','Vegan','Bila Maziwa']},
  {id:'speed',q:"How fast do you want results?",qs:"Unataka kufika lengo lako kwa kasi gani?",type:'opts',
    opts:['Slow & Sustainable','Moderate Pace','Aggressive — max results'],
    sw:['Polepole — endelevu','Wastani','Haraka — matokeo ya haraka']},
];

function clamp(v,lo,hi){return Math.max(lo,Math.min(v,hi));}

// Least-squares slope (kg/day) through every weigh-in in the window, not
// just the first and last — a single water-retention day can no longer
// swing the whole trend the way an endpoint-to-endpoint delta would.
function weightTrendSlope(points){
  var n=points.length;
  if(n<2)return 0;
  var sumX=0,sumY=0,sumXY=0,sumXX=0;
  points.forEach(function(p){sumX+=p.x;sumY+=p.y;sumXY+=p.x*p.y;sumXX+=p.x*p.x;});
  var denom=n*sumXX-sumX*sumX;
  if(denom===0)return 0;
  return(n*sumXY-sumX*sumY)/denom;
}

function calcMaintenance(pr){
  var weight=clamp(pr.weight,20,300),height=clamp(pr.height,50,250),age=clamp(pr.age,10,100);
  var act=Math.max(0,Math.min(parseInt(pr.activity)||2,4));
  var bmr=pr.sex==='male'?10*weight+6.25*height-5*age+5:10*weight+6.25*height-5*age-161;
  return bmr*[1.2,1.375,1.55,1.725,1.9][act];
}

function macrosFor(pr,cal){
  var weight=clamp(pr.weight,20,300);
  var protein=Math.round(weight*(pr.goal==='gain'?2.2:1.8));
  var fat=Math.round(cal*0.25/9);
  var carbs=Math.round(Math.max((cal-protein*4-fat*9)/4,0));
  return{protein:protein,carbs:carbs,fat:fat};
}

function calcTargets(pr){
  var weight=clamp(pr.weight,20,300);
  var cal=calcMaintenance(pr);
  if(pr.goal==='lose') cal-=pr.speed==='slow'?250:pr.speed==='aggressive'?750:500;
  if(pr.goal==='gain') cal+=pr.speed==='slow'?200:pr.speed==='aggressive'?600:400;
  cal=Math.max(cal,1200);
  var m=macrosFor(pr,cal);
  return{calories:Math.round(cal),protein:m.protein,carbs:m.carbs,fat:m.fat,water:Math.round(weight*33)};
}

// "Today" means the user's local calendar day, not UTC — Kenya is UTC+3, so
// anything logged between local midnight and 3am would otherwise land on
// yesterday's UTC date and appear to vanish once the UTC day rolls over.
function localDateStr(d){
  var y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
  return y+'-'+m+'-'+day;
}
function today(){return localDateStr(new Date());}

// Phone camera photos can be several MB — resize/re-encode client-side before
// upload so we stay well under serverless request-body limits and keep the
// scan snappy. Long side capped at 1024px, which is plenty for food ID.
function resizeImage(dataUrl,maxDim){
  return new Promise(function(resolve){
    var img=new Image();
    img.onload=function(){
      var scale=Math.min(1,maxDim/Math.max(img.width,img.height));
      var w=Math.max(1,Math.round(img.width*scale)),h=Math.max(1,Math.round(img.height*scale));
      var canvas=document.createElement('canvas');
      canvas.width=w;canvas.height=h;
      var ctx=canvas.getContext('2d');
      ctx.drawImage(img,0,0,w,h);
      resolve(canvas.toDataURL('image/jpeg',0.82));
    };
    img.onerror=function(){resolve(dataUrl);};
    img.src=dataUrl;
  });
}

async function fetchJSON(url,opts,timeoutMs){
  var controller=new AbortController();
  var timer=setTimeout(function(){controller.abort();},timeoutMs||45000);
  try{
    var r=await fetch(url,Object.assign({},opts,{signal:controller.signal}));
    return await r.json();
  }catch(e){
    if(e.name==='AbortError')throw new Error('Request timed out. Check your connection and try again.',{cause:e});
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

function calcStreak(dateSet){
  var d=new Date();
  var todayStr=today();
  if(!dateSet.has(todayStr)){d.setDate(d.getDate()-1);}
  var count=0;
  while(true){
    var ds=localDateStr(d);
    if(dateSet.has(ds)){count++;d.setDate(d.getDate()-1);}else break;
  }
  return count;
}

// ── GLOBAL STYLES ─────────────────────────────────────────
function GS(){
  return(
    <style>{`
      html,body{height:100%;overflow:hidden;overscroll-behavior:none;-webkit-overflow-scrolling:touch;}
      #root{height:100%;overflow:hidden;}
      *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
      ::-webkit-scrollbar{display:none;}
      input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}
      input[type=number]{-moz-appearance:textfield;}
      input,button{font-family:${FF};}
      @keyframes fadeUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
      @keyframes slideR{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:translateX(0)}}
      @keyframes r1{to{transform:rotate(360deg)}}
      @keyframes scanLine{0%{left:-45%}100%{left:145%}}
      @keyframes toastUp{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
      .page{animation:fadeUp .28s cubic-bezier(.4,0,.2,1) both;}
      .step{animation:slideR .25s cubic-bezier(.4,0,.2,1) both;}
      .bp{width:100%;padding:16px;background:#fff;border:none;border-radius:10px;color:#070707;font-size:15px;font-weight:600;cursor:pointer;letter-spacing:-.01em;transition:transform .1s,opacity .1s;-webkit-tap-highlight-color:transparent;}
      .bp:active{transform:scale(.96);opacity:.82;}
      .bp:disabled{background:#252525;color:#404040;cursor:default;transform:none;opacity:1;}
      .bg{width:100%;padding:12px 16px;background:transparent;border:1px solid rgba(255,255,255,.13);border-radius:10px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:.04em;text-transform:uppercase;transition:transform .1s,opacity .1s;}
      .bg:active{transform:scale(.96);opacity:.7;}
      .ob{padding:15px 16px;background:#0D0D0D;border:1px solid rgba(255,255,255,.06);border-radius:12px;color:#fff;font-size:14px;font-weight:500;cursor:pointer;text-align:left;display:flex;justify-content:space-between;align-items:center;transition:background .12s,transform .1s;width:100%;}
      .ob:active{transform:scale(.98);background:#141414;border-color:rgba(255,255,255,.14);}
      .pill{padding:8px 16px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;letter-spacing:.02em;transition:all .18s;}
      .pill:active{transform:scale(.93);}
      .nb{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:none;cursor:pointer;padding:10px 0 12px;position:relative;}
      .nb:active{opacity:.5;}
      .wb{flex:1;padding:11px;background:#1C1C1C;border:1px solid rgba(255,255,255,.06);border-radius:8px;color:#7A7A7A;font-size:12px;font-weight:600;cursor:pointer;letter-spacing:.02em;transition:all .15s;}
      .wb:active{background:#2a2a2a;transform:scale(.96);color:#fff;}
      .fr{display:flex;justify-content:space-between;align-items:center;width:100%;padding:12px 0;background:none;border:none;cursor:pointer;text-align:left;transition:opacity .12s;}
      .fr:active{opacity:.55;}
      .ic{padding:16px;background:transparent;border:1px solid rgba(255,255,255,.13);border-radius:10px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;text-align:left;display:flex;justify-content:space-between;align-items:center;transition:transform .1s,opacity .12s;width:100%;}
      .ic:active{transform:scale(.98);opacity:.8;}
      .toast{position:fixed;bottom:calc(88px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);background:#fff;color:#070707;padding:11px 22px;border-radius:99px;font-size:13px;font-weight:600;z-index:999;white-space:nowrap;letter-spacing:-.01em;pointer-events:none;animation:toastUp .25s cubic-bezier(.4,0,.2,1) both;}
      .screen-fixed{position:fixed;top:0;left:0;right:0;bottom:0;overflow:hidden;background:#070707;}
      .scroll-inner{height:100%;overflow-y:auto;-webkit-overflow-scrolling:touch;}
    `}</style>
  );
}

// ── ICONS ─────────────────────────────────────────────────
function IcHome(p){var s=p.s||20,c=p.c||W;return(<svg width={s} height={s} viewBox="0 0 20 20" fill="none"><path d="M3 9.5L10 3L17 9.5V17H13.5V12.5H6.5V17H3V9.5Z" stroke={c} strokeWidth={1.5} strokeLinejoin="round"/></svg>);}
function IcLog(p){var s=p.s||20,c=p.c||W;return(<svg width={s} height={s} viewBox="0 0 20 20" fill="none"><rect x="4.5" y="3" width="11" height="14" rx="1.5" stroke={c} strokeWidth={1.5}/><line x1="7" y1="7.5" x2="13" y2="7.5" stroke={c} strokeWidth={1.5} strokeLinecap="round"/><line x1="7" y1="10.5" x2="13" y2="10.5" stroke={c} strokeWidth={1.5} strokeLinecap="round"/><line x1="7" y1="13.5" x2="10.5" y2="13.5" stroke={c} strokeWidth={1.5} strokeLinecap="round"/></svg>);}
function IcScan(p){var s=p.s||20,c=p.c||W;return(<svg width={s} height={s} viewBox="0 0 20 20" fill="none"><path d="M3 7V4H6" stroke={c} strokeWidth={1.5} strokeLinecap="round"/><path d="M14 4H17V7" stroke={c} strokeWidth={1.5} strokeLinecap="round"/><path d="M17 13V16H14" stroke={c} strokeWidth={1.5} strokeLinecap="round"/><path d="M6 16H3V13" stroke={c} strokeWidth={1.5} strokeLinecap="round"/><line x1="3" y1="10" x2="17" y2="10" stroke={c} strokeWidth={1.5} strokeLinecap="round"/></svg>);}
function IcChart(p){var s=p.s||20,c=p.c||W;return(<svg width={s} height={s} viewBox="0 0 20 20" fill="none"><polyline points="2,15 6,9 10,11.5 15,5 18,8" stroke={c} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/></svg>);}
function IcUser(p){var s=p.s||20,c=p.c||W;return(<svg width={s} height={s} viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="3.5" stroke={c} strokeWidth={1.5}/><path d="M2.5 18C2.5 14.5 5.8 12 10 12C14.2 12 17.5 14.5 17.5 18" stroke={c} strokeWidth={1.5} strokeLinecap="round"/></svg>);}
function IcArr(p){var s=p.s||14,c=p.c||W3;return(<svg width={s} height={s} viewBox="0 0 14 14" fill="none"><path d="M2 7H12M8 3L12 7L8 11" stroke={c} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/></svg>);}
function IcX(p){var s=p.s||14,c=p.c||W2;return(<svg width={s} height={s} viewBox="0 0 14 14" fill="none"><line x1="2" y1="2" x2="12" y2="12" stroke={c} strokeWidth={1.5} strokeLinecap="round"/><line x1="12" y1="2" x2="2" y2="12" stroke={c} strokeWidth={1.5} strokeLinecap="round"/></svg>);}
function IcPlus(p){var s=p.s||16,c=p.c||W3;return(<svg width={s} height={s} viewBox="0 0 16 16" fill="none"><line x1="8" y1="2" x2="8" y2="14" stroke={c} strokeWidth={1.5} strokeLinecap="round"/><line x1="2" y1="8" x2="14" y2="8" stroke={c} strokeWidth={1.5} strokeLinecap="round"/></svg>);}
function IcChevron(p){var s=p.s||14,c=p.c||W3,d=p.down;return(<svg width={s} height={s} viewBox="0 0 14 14" fill="none" style={{transform:d?'none':'rotate(180deg)',transition:'transform .2s'}}><path d="M3 5L7 9L11 5" stroke={c} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/></svg>);}

// ── UI PRIMITIVES ─────────────────────────────────────────
function Ring(props){
  var val=props.val||0,max=props.max||1,sz=props.sz||160,th=props.th||10;
  var r=(sz-th)/2,circ=2*Math.PI*r,pct=max>0?Math.min(val/max,1):0;
  return(<div style={{position:'relative',width:sz,height:sz,display:'flex',alignItems:'center',justifyContent:'center'}}><svg width={sz} height={sz} style={{position:'absolute',top:0,left:0,transform:'rotate(-90deg)'}}><circle cx={sz/2} cy={sz/2} r={r} fill="none" stroke={C3} strokeWidth={th}/><circle cx={sz/2} cy={sz/2} r={r} fill="none" stroke={W} strokeWidth={th} strokeDasharray={circ} strokeDashoffset={circ-pct*circ} strokeLinecap="round" style={{transition:'stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)'}}/></svg><div style={{position:'relative',zIndex:1,textAlign:'center'}}>{props.children}</div></div>);
}
function Bar(props){
  var pct=props.max>0?Math.min((props.val||0)/props.max*100,100):0;
  return(<div style={{marginBottom:18}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:7}}><span style={{color:W2,fontSize:10,letterSpacing:'0.1em',textTransform:'uppercase',fontWeight:600}}>{props.label}</span><span style={{color:W,fontSize:13,fontWeight:500}}>{Math.round(props.val||0)}<span style={{color:W3}}> / {props.max}{props.unit||'g'}</span></span></div><div style={{height:2,background:C3,borderRadius:1,overflow:'hidden'}}><div style={{width:pct+'%',height:'100%',background:W,borderRadius:1,transition:'width .8s cubic-bezier(.4,0,.2,1)'}}/></div></div>);
}
function Lbl(props){return <div style={{color:W2,fontSize:10,letterSpacing:'0.1em',textTransform:'uppercase',fontWeight:600,...(props.style||{})}}>{props.ch}</div>;}
function Sep(){return <div style={{height:1,background:BD}}/>;}
function Card(props){return <div style={{background:C1,border:'1px solid '+BD,borderRadius:16,padding:20,marginBottom:12,...(props.style||{})}}>{props.children}</div>;}
function StatBox(props){return(<div style={{background:C2,border:'1px solid '+BD,borderRadius:12,padding:'14px 12px'}}><Lbl ch={props.label} style={{marginBottom:6}}/><div style={{color:W,fontSize:20,fontWeight:700,letterSpacing:'-0.02em',lineHeight:1}}>{props.value}</div>{props.sub&&<div style={{color:W3,fontSize:11,marginTop:4}}>{props.sub}</div>}</div>);}

// ── EMAIL SENT SCREEN ─────────────────────────────────────
function EmailSentScreen(props){
  return(<div className="screen-fixed" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:40,textAlign:'center',fontFamily:FF}}><div style={{width:64,height:64,borderRadius:32,background:C2,border:'1px solid '+BD2,display:'flex',alignItems:'center',justifyContent:'center',marginBottom:28,flexShrink:0}}><svg width={28} height={28} viewBox="0 0 28 28" fill="none"><rect x="3" y="7" width="22" height="16" rx="2" stroke={W} strokeWidth={1.5}/><path d="M3 9L14 16L25 9" stroke={W} strokeWidth={1.5} strokeLinecap="round"/></svg></div><div style={{color:W,fontSize:24,fontWeight:800,letterSpacing:'-0.03em',marginBottom:10}}>{props.title}</div><div style={{color:W2,fontSize:14,lineHeight:1.7,marginBottom:8,maxWidth:280}}>{props.subtitle}</div>{props.email&&<div style={{color:W,fontSize:14,fontWeight:600,marginBottom:32}}>{props.email}</div>}<div style={{color:W3,fontSize:13,lineHeight:1.6,marginBottom:40,maxWidth:280}}>{props.body}</div><button className="bp" onClick={props.onAction} style={{maxWidth:280,width:'100%'}}>{props.actionLabel}</button>{props.hint&&<div style={{color:W3,fontSize:12,marginTop:16}}>{props.hint}</div>}</div>);
}

// ── AUTH ──────────────────────────────────────────────────
function Auth(props){
  var [mode,setMode]=useState('welcome');
  var [name,setName]=useState('');
  var [email,setEmail]=useState('');
  var [password,setPassword]=useState('');
  var [loading,setLoading]=useState(false);
  var [confirmed,setConfirmed]=useState(false);
  var [forgotMode,setForgotMode]=useState(false);
  var [forgotEmail,setForgotEmail]=useState('');
  var [forgotSent,setForgotSent]=useState(false);
  var sw=props.lang==='sw';
  var showToast=props.showToast;
  var inp={width:'100%',padding:'0 0 14px',background:'none',border:'none',borderBottom:'1px solid '+BD2,color:W,outline:'none',boxSizing:'border-box',fontFamily:FF,fontSize:20};

  async function handleAuth(){
    // Mobile keyboards can leave a stray leading/trailing space via
    // autocomplete/autocapitalize; trim the email (never the password —
    // that's exactly what the user typed and shouldn't be second-guessed).
    var cleanEmail=email.trim();
    if(!cleanEmail||!password){showToast('Please fill in all fields.');return;}
    if(mode==='signup'&&password.length<8){showToast('Password must be at least 8 characters.');return;}
    setLoading(true);
    try{
      var r;
      if(mode==='login'){
        r=await supabase.auth.signInWithPassword({email:cleanEmail,password:password});
        if(r.error)throw r.error;
        track('login_completed');
        props.onDone({name:cleanEmail.split('@')[0],email:cleanEmail,id:r.data.user.id});
      } else {
        r=await supabase.auth.signUp({email:cleanEmail,password:password,options:{emailRedirectTo:'https://nutrikenya.vercel.app'}});
        if(r.error)throw r.error;
        track('signup_completed');
        setConfirmed(true);
      }
    }catch(e){showToast(e.message||'Something went wrong.');}
    setLoading(false);
  }

  async function handleForgot(){
    var cleanEmail=forgotEmail.trim();
    if(!cleanEmail){showToast('Enter your email address.');return;}
    setLoading(true);
    var res=await supabase.auth.resetPasswordForEmail(cleanEmail,{redirectTo:'https://nutrikenya.vercel.app'});
    if(res.error){showToast(res.error.message);}else{setForgotSent(true);}
    setLoading(false);
  }

  if(confirmed) return(<EmailSentScreen title="Check your email" subtitle="We sent a confirmation link to" email={email} body="Click the link in the email to activate your account, then come back and log in." actionLabel="Go to Log In" hint="Didn't get it? Check your spam folder." onAction={function(){setConfirmed(false);setMode('login');setPassword('');}}/>);

  if(forgotMode){
    if(forgotSent) return(<EmailSentScreen title="Check your email" subtitle="We sent a password reset link to" email={forgotEmail} body="Click the link in the email to set a new password. The link expires in 24 hours." actionLabel="Back to Log In" hint="Didn't get it? Check your spam folder." onAction={function(){setForgotMode(false);setForgotSent(false);setForgotEmail('');}}/>);
    return(<div className="screen-fixed" style={{display:'flex',flexDirection:'column',fontFamily:FF}}><div style={{padding:'calc(52px + env(safe-area-inset-top)) 24px 24px',display:'flex',flexDirection:'column',flex:1,overflow:'hidden'}}><button className="bg" onClick={function(){setForgotMode(false);}} style={{width:'auto',alignSelf:'flex-start',padding:'8px 16px',marginBottom:32,flexShrink:0}}>← BACK</button><div style={{maxWidth:340,width:'100%',margin:'0 auto'}}><div style={{fontSize:28,fontWeight:800,color:W,letterSpacing:'-0.03em',marginBottom:6}}>Forgot password?</div><div style={{color:W2,fontSize:14,marginBottom:36,lineHeight:1.6}}>Enter the email address for your account and we'll send you a reset link.</div><div style={{marginBottom:32}}><Lbl ch="Email" style={{marginBottom:10}}/><input value={forgotEmail} onChange={function(e){setForgotEmail(e.target.value);}} onKeyDown={function(e){if(e.key==='Enter')handleForgot();}} placeholder="your@email.com" type="email" autoCapitalize="none" autoCorrect="off" spellCheck="false" autoFocus style={inp}/></div><button className="bp" onClick={handleForgot} disabled={loading}>{loading?'Sending...':'Send Reset Link'}</button></div></div></div>);
  }

  if(mode==='welcome') return(
    <div className="screen-fixed" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:32,textAlign:'center',fontFamily:FF}}>
      <div style={{position:'absolute',inset:0,backgroundImage:'radial-gradient(circle,rgba(255,255,255,0.05) 1px,transparent 1px)',backgroundSize:'32px 32px',pointerEvents:'none'}}/>
      <div style={{position:'relative',zIndex:1,display:'flex',flexDirection:'column',alignItems:'center'}}>
        <div style={{position:'relative',width:136,height:136,marginBottom:36,pointerEvents:'none',flexShrink:0}}>
          <svg width={136} height={136} viewBox="0 0 120 120">
            <circle cx={60} cy={60} r={50} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={1.25}/>
            <path d="M26,80 L41,52 L47,59 L58,34 L70,63 L80,52 L94,80" fill="none" stroke={W} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round"/>
            <g style={{animation:'r1 22s linear infinite',transformOrigin:'60px 60px'}}>
              <circle cx={60} cy={60} r={50} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={1.5} strokeDasharray="26 288" strokeLinecap="round"/>
            </g>
          </svg>
        </div>
        <div style={{fontSize:36,fontWeight:900,color:W,letterSpacing:'-0.05em',lineHeight:1,marginBottom:10}}>NUTRIKENYA</div>
        <div style={{color:W2,fontSize:11,letterSpacing:'0.2em',textTransform:'uppercase',marginBottom:52}}>{sw?'INTELIJENSIA YA LISHE · KENYA':'NUTRITION INTELLIGENCE · KENYA'}</div>
        <div style={{width:'100%',maxWidth:300,display:'flex',flexDirection:'column',gap:10}}>
          <button className="bp" onClick={function(){setMode('signup');}}>GET STARTED</button>
          <button className="bg" onClick={function(){setMode('login');}}>LOG IN</button>
        </div>
      </div>
      <div style={{position:'absolute',bottom:'calc(24px + env(safe-area-inset-bottom))',display:'flex',flexDirection:'column',alignItems:'center',gap:8}}>
        <div style={{color:W3,fontSize:10,letterSpacing:'0.1em',textTransform:'uppercase',pointerEvents:'none'}}>Made in Kenya</div>
        <div style={{fontSize:10,letterSpacing:'0.04em'}}><span onClick={function(){props.onLegal('privacy');}} style={{color:W3,cursor:'pointer'}}>Privacy</span><span style={{color:W3,margin:'0 6px'}}>·</span><span onClick={function(){props.onLegal('terms');}} style={{color:W3,cursor:'pointer'}}>Terms</span></div>
      </div>
    </div>
  );

  return(
    <div className="screen-fixed" style={{display:'flex',flexDirection:'column',fontFamily:FF}}>
      <div style={{padding:'calc(52px + env(safe-area-inset-top)) 24px 24px',display:'flex',flexDirection:'column',flex:1,overflow:'hidden'}}>
        <button className="bg" onClick={function(){setMode('welcome');}} style={{width:'auto',alignSelf:'flex-start',padding:'8px 16px',marginBottom:32,flexShrink:0}}>← BACK</button>
        <div style={{maxWidth:340,width:'100%',margin:'0 auto',flex:1,overflowY:'auto'}}>
          <div style={{fontSize:30,fontWeight:800,color:W,letterSpacing:'-0.03em',lineHeight:1.1,marginBottom:6}}>{mode==='login'?'Welcome back.':'Create account.'}</div>
          <div style={{color:W2,fontSize:14,marginBottom:36}}>{mode==='login'?'Continue your journey.':'Your transformation starts here.'}</div>
          {mode==='signup'&&<div style={{marginBottom:24}}><Lbl ch="Name" style={{marginBottom:10}}/><input value={name} onChange={function(e){setName(e.target.value);}} placeholder="Your name" autoFocus style={inp}/></div>}
          <div style={{marginBottom:24}}><Lbl ch="Email" style={{marginBottom:10}}/><input value={email} onChange={function(e){setEmail(e.target.value);}} placeholder="your@email.com" type="email" autoCapitalize="none" autoCorrect="off" spellCheck="false" autoFocus={mode==='login'} style={inp}/></div>
          <div style={{marginBottom:mode==='login'?16:32}}><Lbl ch="Password" style={{marginBottom:10}}/><input value={password} onChange={function(e){setPassword(e.target.value);}} onKeyDown={function(e){if(e.key==='Enter')handleAuth();}} placeholder={mode==='signup'?'Min. 8 characters':'Your password'} type="password" style={inp}/></div>
          {mode==='login'&&<div style={{textAlign:'right',marginBottom:28}}><span onClick={function(){setForgotMode(true);setForgotEmail(email);}} style={{color:W2,fontSize:12,cursor:'pointer',letterSpacing:'0.02em'}}>Forgot password?</span></div>}
          <button className="bp" onClick={handleAuth} disabled={loading}>{loading?'Please wait...':(mode==='login'?'Log In':'Continue')}</button>
          <p style={{textAlign:'center',color:W3,fontSize:12,marginTop:16}}>{mode==='login'?<span onClick={function(){setMode('signup');}} style={{color:W2,cursor:'pointer'}}>No account? Sign up</span>:<span onClick={function(){setMode('login');}} style={{color:W2,cursor:'pointer'}}>Have an account? Log in</span>}</p>
        </div>
      </div>
    </div>
  );
}

// ── RESET PASSWORD ────────────────────────────────────────
function ResetPassword(props){
  var [newPass,setNewPass]=useState('');
  var [confirm,setConfirm]=useState('');
  var [loading,setLoading]=useState(false);
  var [done,setDone]=useState(false);
  var inp={width:'100%',padding:'0 0 14px',background:'none',border:'none',borderBottom:'1px solid '+BD2,color:W,outline:'none',boxSizing:'border-box',fontFamily:FF,fontSize:20};
  var showToast=props.showToast;
  async function handleReset(){
    if(!newPass||newPass.length<8){showToast('Password must be at least 8 characters.');return;}
    if(newPass!==confirm){showToast('Passwords do not match.');return;}
    setLoading(true);
    var res=await supabase.auth.updateUser({password:newPass});
    if(res.error){showToast(res.error.message);setLoading(false);return;}
    setDone(true);setLoading(false);
    setTimeout(function(){props.onDone();},2200);
  }
  if(done) return(<div className="screen-fixed" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:40,textAlign:'center',fontFamily:FF}}><div style={{width:64,height:64,borderRadius:32,background:C2,border:'1px solid '+BD2,display:'flex',alignItems:'center',justifyContent:'center',marginBottom:28}}><svg width={28} height={28} viewBox="0 0 28 28" fill="none"><path d="M6 14L11 19L22 9" stroke={W} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/></svg></div><div style={{color:W,fontSize:24,fontWeight:800,letterSpacing:'-0.03em',marginBottom:10}}>Password updated.</div><div style={{color:W2,fontSize:14,lineHeight:1.7,maxWidth:280}}>Your password has been changed. Taking you back now.</div></div>);
  return(<div className="screen-fixed" style={{display:'flex',flexDirection:'column',fontFamily:FF}}><div style={{padding:'calc(60px + env(safe-area-inset-top)) 24px 24px',display:'flex',flexDirection:'column',flex:1}}><div style={{maxWidth:340,width:'100%',margin:'0 auto'}}><div style={{fontSize:28,fontWeight:800,color:W,letterSpacing:'-0.03em',marginBottom:6}}>Set new password.</div><div style={{color:W2,fontSize:14,marginBottom:40,lineHeight:1.6}}>Choose a strong password for your NutriKenya account.</div><div style={{marginBottom:28}}><Lbl ch="New Password" style={{marginBottom:10}}/><input value={newPass} onChange={function(e){setNewPass(e.target.value);}} placeholder="Min. 8 characters" type="password" autoFocus style={inp}/></div><div style={{marginBottom:36}}><Lbl ch="Confirm Password" style={{marginBottom:10}}/><input value={confirm} onChange={function(e){setConfirm(e.target.value);}} onKeyDown={function(e){if(e.key==='Enter')handleReset();}} placeholder="Repeat password" type="password" style={inp}/></div><button className="bp" onClick={handleReset} disabled={loading||!newPass||!confirm}>{loading?'Updating...':'Update Password'}</button></div></div></div>);
}

// ── LEGAL (PRIVACY / TERMS) ────────────────────────────────
var PRIVACY_SECTIONS=[
  {h:'What NutriKenya is',b:"NutriKenya is a nutrition-tracking app for Kenya. This policy explains what information we collect, why, and the rights you have over it under Kenya's Data Protection Act, 2019."},
  {h:'Information we collect',b:'Account info (email, password — password is never visible to us, Supabase Auth stores it hashed). Profile info you provide during onboarding (name, age, sex, weight, height, activity level, goals, dietary restrictions). Food logs, body measurements, and water intake you choose to record. Meal photos you submit to the AI Scanner.'},
  {h:'How meal photos are handled',b:'Photos you scan are sent to our AI provider (Anthropic) solely to estimate nutrition, and are not stored by NutriKenya after the estimate is returned. We do not use your photos to train any model.'},
  {h:'Who we share data with',b:'We use a small number of service providers to run NutriKenya: Supabase (database hosting and authentication), Anthropic (AI food-photo and meal-plan analysis), and Resend (account and password-reset emails). We do not sell your personal data to anyone, ever.'},
  {h:'How long we keep it',b:'Your data is kept while your account is active. If you delete your account, your profile, logs, and metrics are permanently removed from our database.'},
  {h:'Your rights',b:'Under the Data Protection Act, 2019, you have the right to access, correct, delete, restrict, or export (in a portable format) your personal data, and to object to how it is processed. To exercise any of these, contact us using the details below — most of this you can already do yourself from the Profile screen (edit your data, or Sign Out & Reset to clear a local session).'},
  {h:'Security',b:"All traffic to NutriKenya is encrypted (HTTPS). Your data is protected by row-level security rules that mean only you can read or write your own records, enforced at the database level, not just in the app's interface."},
  {h:'Children',b:'NutriKenya is not directed at children under 18. If you believe a child has created an account, contact us and we will remove it.'},
  {h:'Changes to this policy',b:"If this policy changes materially, we'll update the date below. Continued use of NutriKenya after a change means you accept the update."},
  {h:'Contact',b:'Questions or requests about your data: privacy@aiscope.online'},
];
var TERMS_SECTIONS=[
  {h:'Agreement',b:'By creating a NutriKenya account, you agree to these terms. If you don’t agree, please don’t use the app.'},
  {h:'Not medical advice',b:'NutriKenya provides estimates — calorie and macro targets, AI food-photo analysis, and meal suggestions are calculated from general formulas and Kenyan food-composition data, and can be inaccurate. Nothing in this app is medical, dietary, or clinical advice. If you have a health condition, are pregnant, or have specific dietary needs, talk to a qualified healthcare professional before making decisions based on anything NutriKenya shows you.'},
  {h:'Your account',b:'You’re responsible for the accuracy of the information you enter and for keeping your password secure. You must be 18 or older to create an account.'},
  {h:'Acceptable use',b:'Use NutriKenya only for its intended purpose — personal nutrition tracking. Don’t attempt to abuse, overload, or reverse-engineer the AI features, and don’t use the service for anything unlawful.'},
  {h:'AI feature limits',b:'AI photo scanning, quick-add parsing, and meal-plan generation have real per-use cost to us. We may rate-limit, throttle, or place these behind a paid tier at any time; core manual food logging will always remain free.'},
  {h:'Subscriptions',b:'NutriKenya is currently free. If we introduce paid plans, pricing and billing terms (including via M-Pesa) will be shown clearly before you’re charged, and this section will be updated.'},
  {h:'No warranty',b:'NutriKenya is provided "as is." We work to keep nutrition data accurate, but we don’t guarantee it’s error-free, and we’re not liable for decisions made based on the app’s estimates.'},
  {h:'Ending your account',b:'You can stop using NutriKenya at any time via Sign Out & Reset. To permanently delete your account and data, contact us at the address below.'},
  {h:'Governing law',b:'These terms are governed by the laws of Kenya.'},
  {h:'Contact',b:'Questions about these terms: legal@aiscope.online'},
];
function LegalDoc(props){
  var isPrivacy=props.doc==='privacy';
  var sections=isPrivacy?PRIVACY_SECTIONS:TERMS_SECTIONS;
  return(
    <div className="screen-fixed" style={{display:'flex',flexDirection:'column',fontFamily:FF}}>
      <div style={{padding:'calc(52px + env(safe-area-inset-top)) 24px 24px',display:'flex',flexDirection:'column',flex:1,overflow:'hidden'}}>
        <button className="bg" onClick={props.onBack} style={{width:'auto',alignSelf:'flex-start',padding:'8px 16px',marginBottom:24,flexShrink:0}}>← BACK</button>
        <div style={{maxWidth:520,width:'100%',margin:'0 auto',flex:1,overflowY:'auto',paddingBottom:24}}>
          <div style={{fontSize:26,fontWeight:800,color:W,letterSpacing:'-0.03em',marginBottom:6}}>{isPrivacy?'Privacy Policy':'Terms of Service'}</div>
          <div style={{color:W3,fontSize:12,marginBottom:28}}>Last updated 27 July 2026</div>
          {sections.map(function(s,i){return(<div key={i} style={{marginBottom:22}}><div style={{color:W,fontSize:13,fontWeight:700,letterSpacing:'0.02em',marginBottom:6,textTransform:'uppercase'}}>{s.h}</div><div style={{color:W2,fontSize:14,lineHeight:1.7}}>{s.b}</div></div>);})}
        </div>
      </div>
    </div>
  );
}

// ── ONBOARD ───────────────────────────────────────────────
function Onboard(props){
  var [step,setStep]=useState(0);
  var [ans,setAns]=useState({});
  var [val,setVal]=useState('');
  var [htUnit,setHtUnit]=useState('cm');
  var [htFt,setHtFt]=useState('');
  var [htIn,setHtIn]=useState('');
  var q=QS[step],sw=props.lang==='sw';
  useEffect(function(){track('onboarding_started');},[]);
  function htCm(){return htUnit==='cm'?(parseFloat(val)||170):Math.round(parseFloat(htFt||0)*30.48+parseFloat(htIn||0)*2.54)||170;}
  var htOk=q.type==='height'?(htUnit==='cm'?!!val:(!!htFt||!!htIn)):true;
  function next(v){
    var a=Object.assign({},ans);
    a[q.id]=q.id==='height'?htCm():(v!==undefined?v:val);
    setAns(a);setVal('');
    track('onboarding_step_completed',{step:step,question_id:q.id});
    if(step===QS.length-1){
      var gl=a.goal;
      var goal=(gl&&(gl.includes('Lose')||gl.includes('Kupunguza')))?'lose':(gl&&(gl.includes('Build')||gl.includes('Kujenga')))?'gain':(gl&&(gl.includes('Recomp')||gl.includes('Kubadilisha')))?'recomp':'maintain';
      var sp=a.speed;
      var speed=(sp&&(sp.includes('Slow')||sp.includes('Polepole')))?'slow':(sp&&(sp.includes('Aggressive')||sp.includes('Haraka')))?'aggressive':'moderate';
      var actIdx=['Sedentary','Lightly','Moderately','Very Active','Extremely'].findIndex(function(x){return a.activity&&a.activity.includes(x);});
      track('onboarding_completed',{goal:goal,speed:speed});
      props.onDone({name:a.name||props.uname,age:parseInt(a.age)||25,sex:(a.sex==='Male'||a.sex==='Mume')?'male':'female',weight:parseFloat(a.weight)||70,height:parseFloat(a.height)||170,goal:goal,speed:speed,activity:Math.max(0,actIdx<0?2:actIdx),workoutDays:parseInt(a.workoutDays)||3,workoutType:a.workoutType,restrictions:a.restrictions||'None',targetWeight:parseFloat(a.targetWeight)||0});
    } else {setStep(function(s){return s+1;});}
  }
  function goBack(){
    var prevStep=step-1,prevQ=QS[prevStep],prevAns=ans[prevQ.id];
    if(prevQ.type==='height'){
      setHtUnit('cm');setVal(prevAns!==undefined?String(prevAns):'');setHtFt('');setHtIn('');
    } else {
      setVal(prevAns!==undefined?String(prevAns):'');
    }
    setStep(prevStep);
  }
  var bigNum={flex:1,padding:'0 0 14px',background:'none',border:'none',borderBottom:'1px solid '+BD2,color:W,fontSize:48,fontWeight:700,outline:'none',letterSpacing:'-0.04em',fontFamily:FF,textAlign:'center'};
  return(
    <div className="screen-fixed" style={{display:'flex',flexDirection:'column',fontFamily:FF,padding:'0 24px'}}>
      <div style={{paddingTop:'calc(24px + env(safe-area-inset-top))',flexShrink:0}}>
        <div style={{height:1,background:C3,marginBottom:12,position:'relative',borderRadius:1}}><div style={{position:'absolute',top:0,left:0,height:'100%',background:W,width:((step/QS.length)*100)+'%',transition:'width .5s cubic-bezier(.4,0,.2,1)',borderRadius:1}}/></div>
        <div style={{display:'flex',justifyContent:'center',gap:5,marginBottom:28}}>{QS.map(function(_,i){return(<div key={i} style={{width:i===step?14:4,height:4,borderRadius:99,background:i===step?W:i<step?W3:C3,transition:'all .3s cubic-bezier(.4,0,.2,1)'}}/>);})}</div>
      </div>
      <div style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column'}}>
        <div key={step} className="step" style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
          <Lbl ch={(step+1)+' of '+QS.length} style={{marginBottom:12,flexShrink:0}}/>
          <div style={{fontSize:24,fontWeight:700,color:W,letterSpacing:'-0.02em',lineHeight:1.25,marginBottom:24,flexShrink:0}}>{sw?q.qs:q.q}</div>
          {q.type==='text'&&(<div style={{flex:1,display:'flex',flexDirection:'column'}}><input value={val} onChange={function(e){setVal(e.target.value);}} onKeyDown={function(e){if(e.key==='Enter'&&val)next();}} placeholder={q.ph} autoFocus style={{width:'100%',padding:'0 0 14px',background:'none',border:'none',borderBottom:'1px solid '+BD2,color:W,fontSize:24,outline:'none',boxSizing:'border-box',fontFamily:FF,marginBottom:24,flexShrink:0}}/><button className="bp" onClick={function(){if(val)next();}} disabled={!val}>Continue</button></div>)}
          {q.type==='number'&&(<div style={{flex:1,display:'flex',flexDirection:'column'}}><div style={{display:'flex',alignItems:'baseline',gap:12,marginBottom:24}}><input type="number" value={val} onChange={function(e){setVal(e.target.value);}} onKeyDown={function(e){if(e.key==='Enter'&&val)next();}} placeholder={q.ph} autoFocus style={bigNum}/><span style={{color:W2,fontSize:15,fontWeight:500,minWidth:50}}>{q.unit}</span></div><button className="bp" onClick={function(){if(val)next();}} disabled={!val}>Continue</button></div>)}
          {q.type==='height'&&(<div style={{flex:1,display:'flex',flexDirection:'column'}}><div style={{display:'flex',gap:8,marginBottom:20,flexShrink:0}}>{[{v:'cm',l:'Centimeters'},{v:'ft',l:'Feet & Inches'}].map(function(u){var active=htUnit===u.v;return(<button key={u.v} className="pill" onClick={function(){setHtUnit(u.v);setVal('');setHtFt('');setHtIn('');}} style={{flex:1,padding:'9px',background:active?W:C2,border:'1px solid '+(active?W:BD),borderRadius:8,color:active?BG:W2,fontSize:12,fontWeight:600}}>{u.l}</button>);})}</div>{htUnit==='cm'?(<div style={{display:'flex',alignItems:'baseline',gap:12,marginBottom:24}}><input type="number" value={val} onChange={function(e){setVal(e.target.value);}} autoFocus placeholder="170" style={bigNum}/><span style={{color:W2,fontSize:15}}>cm</span></div>):(<div style={{display:'flex',gap:14,marginBottom:24}}>{[{label:'Feet',state:htFt,set:setHtFt,ph:'5',unit:'ft',af:true},{label:'Inches',state:htIn,set:setHtIn,ph:'10',unit:'in',af:false}].map(function(f){return(<div key={f.label} style={{flex:1}}><Lbl ch={f.label} style={{marginBottom:8}}/><div style={{display:'flex',alignItems:'baseline',gap:6}}><input type="number" value={f.state} onChange={function(e){f.set(e.target.value);}} placeholder={f.ph} autoFocus={f.af} style={{...bigNum,fontSize:38,textAlign:'left'}}/><span style={{color:W2,fontSize:13}}>{f.unit}</span></div></div>);})}</div>)}<button className="bp" onClick={function(){if(htOk)next();}} disabled={!htOk}>Continue</button></div>)}
          {q.type==='opts'&&(<div style={{flex:1,overflowY:'auto',display:'flex',flexDirection:'column',gap:8,paddingBottom:8}}>{(sw?q.sw:q.opts).map(function(opt,i){var selected=ans[q.id]===q.opts[i];return(<button key={i} className="ob" onClick={function(){next(q.opts[i]);}} style={selected?{borderColor:'rgba(255,255,255,0.35)',background:C2}:undefined}><span style={{lineHeight:1.35}}>{opt}</span><IcArr c={selected?W:W3}/></button>);})}</div>)}
        </div>
      </div>
      <div style={{paddingBottom:'calc(16px + env(safe-area-inset-bottom))',paddingTop:12,flexShrink:0}}>{step>0?<button className="bg" onClick={goBack} style={{width:'auto',padding:'8px 16px'}}>← BACK</button>:<div style={{height:38}}/>}</div>
    </div>
  );
}

// ── DASHBOARD ─────────────────────────────────────────────
function Dash(props){
  var profile=props.profile,targets=props.targets,log=props.log,water=props.water,setWater=props.setWater,score=props.score,lang=props.lang,streak=props.streak,fasting=props.fasting,setFasting=props.setFasting,fStart=props.fStart,setFStart=props.setFStart,showToast=props.showToast,userId=props.userId,foods=props.foods||[];
  var sw=lang==='sw';
  // fStart is lifted to the parent so the timer survives switching tabs away
  // from Dashboard and back (this component unmounts/remounts on tab change).
  var [elapsed,setElapsed]=useState(function(){return fasting&&fStart?Math.floor((Date.now()-fStart)/1000):0;});
  useEffect(function(){
    // Stopping resets elapsed/fStart in the button handler itself (below), so
    // this effect only ever needs to start the ticking interval.
    if(!fasting)return;
    var t0=fStart||Date.now();if(!fStart)setFStart(t0);
    var t=setInterval(function(){setElapsed(Math.floor((Date.now()-t0)/1000));},1000);
    return function(){clearInterval(t);};
  },[fasting,fStart,setFStart]);
  var all=log.breakfast.concat(log.lunch,log.dinner,log.snacks);
  var tot=all.reduce(function(a,i){return{cal:a.cal+i.e,p:a.p+i.p,c:a.c+i.c,f:a.f+i.f};},{cal:0,p:0,c:0,f:0});
  var rem=Math.max(targets.calories-tot.cal,0);
  var hr=new Date().getHours();
  var greet=hr<12?'Morning':hr<17?'Afternoon':'Evening';
  var mLbls={breakfast:'Breakfast',lunch:'Lunch',dinner:'Dinner',snacks:'Snacks'};
  var mLblsSw={breakfast:'Kifungua Kinywa',lunch:'Chakula cha Mchana',dinner:'Chakula cha Jioni',snacks:'Vitafunio'};
  function fmtT(s){return String(Math.floor(s/3600)).padStart(2,'0')+':'+String(Math.floor((s%3600)/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}
  async function handleWater(v){
    var nw=Math.min(water+v,6000);setWater(nw);showToast('+'+v+'ml water logged');
    if(!userId)return;
    var payload={userId:userId,water_logged:nw,water_date:today()};
    if(!navigator.onLine){queueWrite('water-update',payload);return;}
    try{
      var res=await supabase.from('profiles').update({water_logged:nw,water_date:today()}).eq('id',userId);
      if(res.error)throw res.error;
    }catch(e){console.error(e);logError('water-update',e,userId);queueWrite('water-update',payload);}
  }
  var highProtein=foods.filter(function(f){return f.p>=15;}).slice(0,3);
  return(
    <div className="page" style={{padding:'24px 20px 100px',fontFamily:FF}}>
      <div style={{marginBottom:24}}>
        <div style={{color:W2,fontSize:12,letterSpacing:'0.08em',textTransform:'uppercase',marginBottom:4}}>{sw?'Habari':'Good '+greet}</div>
        <div style={{color:W,fontSize:28,fontWeight:800,letterSpacing:'-0.03em',marginBottom:10}}>{profile.name}</div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>{[{t:streak+' DAY STREAK'},{t:'SCORE '+score+'/100'},{t:profile.goal==='lose'?'FAT LOSS':profile.goal==='gain'?'MUSCLE GAIN':profile.goal==='recomp'?'RECOMP':'MAINTAIN'}].map(function(x,i){return <span key={i} style={{background:C2,border:'1px solid '+BD,borderRadius:20,padding:'4px 12px',color:i===2?W:W2,fontSize:10,fontWeight:600,letterSpacing:'0.05em'}}>{x.t}</span>;})}</div>
      </div>
      <Card><div style={{display:'flex',alignItems:'center',gap:20}}><Ring val={tot.cal} max={targets.calories} sz={144} th={11}><div style={{fontSize:24,fontWeight:800,color:W,letterSpacing:'-0.03em'}}>{Math.round(tot.cal)}</div><div style={{color:W3,fontSize:10,letterSpacing:'0.06em',textTransform:'uppercase'}}>eaten</div></Ring><div style={{flex:1}}><Lbl ch={sw?'Zilizobaki':'Remaining'} style={{marginBottom:4}}/><div style={{fontSize:38,fontWeight:900,color:W,letterSpacing:'-0.04em',lineHeight:1}}>{rem}</div><div style={{color:W3,fontSize:12,marginBottom:14}}>of {targets.calories} kcal</div><div style={{height:1,background:BD,marginBottom:10}}/><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>{[{l:'Protein',v:targets.protein+'g'},{l:'Carbs',v:targets.carbs+'g'},{l:'Fat',v:targets.fat+'g'},{l:'Water',v:(targets.water/1000).toFixed(1)+'L'}].map(function(x,i){return(<div key={i}><Lbl ch={x.l} style={{marginBottom:2}}/><div style={{color:W,fontSize:12,fontWeight:600}}>{x.v}</div></div>);})}</div></div></div></Card>
      <Card><Lbl ch={sw?'Virutubisho':'Macronutrients'} style={{marginBottom:18}}/><Bar label={sw?'Protini':'Protein'} val={tot.p} max={targets.protein}/><Bar label={sw?'Wanga':'Carbohydrates'} val={tot.c} max={targets.carbs}/><Bar label={sw?'Mafuta':'Fat'} val={tot.f} max={targets.fat}/><div style={{height:1,background:BD,margin:'16px 0'}}/><Bar label={sw?'Maji':'Water'} val={water} max={targets.water} unit="ml"/><div style={{display:'flex',gap:8,marginTop:12}}>{[250,500].map(function(v){return(<button key={v} className="wb" onClick={function(){handleWater(v);}}>+{v} ml</button>);})}</div></Card>
      <Card><Lbl ch={sw?'Milo ya Leo':"Today's Meals"} style={{marginBottom:14}}/>{['breakfast','lunch','dinner','snacks'].map(function(m,i,arr){var items=log[m],kcal=items.reduce(function(a,x){return a+x.e;},0);return(<div key={m}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'11px 0'}}><div><div style={{color:W,fontSize:14,fontWeight:500}}>{sw?mLblsSw[m]:mLbls[m]}</div><div style={{color:W3,fontSize:11,marginTop:2}}>{items.length>0?items.length+' item'+(items.length!==1?'s':''):'Empty'}</div></div><div style={{color:kcal>0?W:W3,fontSize:14,fontWeight:600}}>{kcal>0?kcal+' kcal':'—'}</div></div>{i<arr.length-1&&<Sep/>}</div>);})}</Card>
      {highProtein.length>0&&<Card><Lbl ch="Smart Picks — High Protein" style={{marginBottom:12}}/><div style={{color:W2,fontSize:13,marginBottom:12,lineHeight:1.5}}>{Math.round(Math.max(targets.protein-tot.p,0))}g protein left today</div>{highProtein.map(function(f,i,arr){return(<div key={f.id}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0'}}><div><div style={{color:W,fontSize:13,fontWeight:500}}>{sw?f.s:f.n}</div><div style={{color:W3,fontSize:11,marginTop:2}}>{f.pr}</div></div><div style={{textAlign:'right'}}><div style={{color:W,fontSize:13,fontWeight:600}}>{f.p}g protein</div><div style={{color:W3,fontSize:11}}>{f.e} kcal</div></div></div>{i<arr.length-1&&<Sep/>}</div>);})}</Card>}
      <Card style={{border:'1px solid '+(fasting?BD2:BD)}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><div><Lbl ch={sw?'Kipindi cha Kufunga':'Fasting Timer'} style={{marginBottom:8}}/><div style={{color:W,fontSize:32,fontWeight:700,letterSpacing:'0.04em',fontVariantNumeric:'tabular-nums'}}>{fmtT(elapsed)}</div><div style={{color:W3,fontSize:11,marginTop:4,letterSpacing:'0.04em',textTransform:'uppercase'}}>{fasting?'Active':'Not active'}</div></div><button className="bp" onClick={function(){setFasting(function(f){if(f){setFStart(null);setElapsed(0);}return!f;});}} style={{width:'auto',padding:'12px 20px',letterSpacing:'0.06em',textTransform:'uppercase',fontSize:12}}>{fasting?'Stop':'Start'}</button></div></Card>
      <Card><Lbl ch="Body Rebuild Score" style={{marginBottom:14}}/><div style={{display:'flex',alignItems:'center',gap:20}}><Ring val={score} max={100} sz={84} th={8}><div style={{fontSize:18,fontWeight:800,color:W}}>{score}</div></Ring><div style={{flex:1}}><div style={{color:W2,fontSize:13,marginBottom:12,lineHeight:1.5}}>Stay consistent to grow your score</div>{[{l:'Hit calorie goal',p:'+10 pts'},{l:'Log all meals',p:'+5 pts'},{l:'Hit water target',p:'+3 pts'},{l:'Weekly check-in',p:'+5 pts'}].map(function(x,i){return(<div key={i} style={{display:'flex',justifyContent:'space-between',padding:'4px 0'}}><span style={{color:W3,fontSize:12}}>{x.l}</span><span style={{color:W2,fontSize:12,fontWeight:600}}>{x.p}</span></div>);})}</div></div></Card>
    </div>
  );
}

// ── LOG ───────────────────────────────────────────────────
// ── BARCODE SCAN ──────────────────────────────────────────
// Looks up a scanned barcode against Open Food Facts (free, no API key) and
// normalizes its per-100g nutriments into the same food-item shape used
// everywhere else in the app.
async function lookupBarcode(code){
  var data=await fetchJSON('https://world.openfoodfacts.org/api/v2/product/'+encodeURIComponent(code)+'.json?fields=product_name,generic_name,nutriments',{},15000);
  if(!data||data.status!==1||!data.product)return null;
  var p=data.product,n=p.nutriments||{};
  var name=p.product_name||p.generic_name;
  if(!name)return null;
  var kcal100=n['energy-kcal_100g'];
  if(kcal100===undefined&&n.energy_100g!==undefined)kcal100=n.energy_100g/4.184;
  return{n:name,s:name,e:Math.round(kcal100||0),p:Math.round((n.proteins_100g||0)*10)/10,c:Math.round((n.carbohydrates_100g||0)*10)/10,f:Math.round((n.fat_100g||0)*10)/10,pr:'100g',cat:'Barcode'};
}
function BarcodeScan(props){
  var onFound=props.onFound,showToast=props.showToast,lang=props.lang;
  var sw=lang==='sw';
  var supported=typeof window!=='undefined'&&'BarcodeDetector' in window;
  var [scanning,setScanning]=useState(false);
  var [loading,setLoading]=useState(false);
  var [manualCode,setManualCode]=useState('');
  var [camError,setCamError]=useState(null);
  var videoRef=useRef();

  async function handleCode(code){
    setScanning(false);setLoading(true);setCamError(null);
    try{
      var product=await lookupBarcode(code);
      if(!product){showToast('No product found for that barcode.');}else{onFound(product);}
    }catch(e){console.error(e);logError('barcode-lookup',e);showToast(e.message&&e.message.indexOf('timed out')>-1?e.message:'Lookup failed. Check your connection.');}
    setLoading(false);
  }

  useEffect(function(){
    if(!supported||!scanning)return;
    var stopped=false,stream=null,raf=null;
    (async function(){
      try{
        stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
        if(stopped){stream.getTracks().forEach(function(t){t.stop();});return;}
        if(videoRef.current){videoRef.current.srcObject=stream;await videoRef.current.play();}
        var detector=new window.BarcodeDetector({formats:['ean_13','ean_8','upc_a','upc_e','code_128']});
        function loop(){
          if(stopped)return;
          if(videoRef.current&&videoRef.current.readyState>=2){
            detector.detect(videoRef.current).then(function(codes){
              if(stopped)return;
              if(codes&&codes.length>0){stopped=true;handleCode(codes[0].rawValue);}
              else{raf=requestAnimationFrame(loop);}
            }).catch(function(){if(!stopped)raf=requestAnimationFrame(loop);});
          }else{raf=requestAnimationFrame(loop);}
        }
        loop();
      }catch(camErr){
        console.error(camErr);
        if(!stopped){setCamError('Camera access denied or unavailable.');setScanning(false);}
      }
    })();
    return function(){
      stopped=true;
      if(raf)cancelAnimationFrame(raf);
      if(stream)stream.getTracks().forEach(function(t){t.stop();});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scanning,supported]);

  if(!supported){
    return(
      <div>
        <div style={{color:W2,fontSize:12,marginBottom:14,lineHeight:1.6}}>{sw?'Kusoma bakoodi kwa kamera hakuungwi mkono na kivinjari hiki. Andika nambari ya bakoodi badala yake.':"Live barcode scanning isn't supported on this browser. Enter the barcode number instead."}</div>
        <div style={{display:'flex',gap:8}}>
          <input value={manualCode} onChange={function(e){setManualCode(e.target.value.replace(/\D/g,''));}} onKeyDown={function(e){if(e.key==='Enter'&&manualCode)handleCode(manualCode);}} placeholder="e.g. 6009xxxxxxxxx" inputMode="numeric" style={{flex:1,padding:'11px 13px',background:C2,border:'1px solid '+BD,borderRadius:8,color:W,fontSize:14,outline:'none',boxSizing:'border-box',fontFamily:FF}}/>
          <button className="bg" disabled={!manualCode||loading} onClick={function(){handleCode(manualCode);}} style={{width:'auto',padding:'0 18px'}}>{loading?'...':'Look Up'}</button>
        </div>
      </div>
    );
  }
  return(
    <div>
      {!scanning&&!loading&&(
        <div onClick={function(){setCamError(null);setScanning(true);}} style={{border:'1px dashed '+BD2,borderRadius:16,padding:44,textAlign:'center',cursor:'pointer',marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'center',marginBottom:14}}><IcScan s={32} c={W3}/></div>
          <div style={{color:W,fontSize:15,fontWeight:600,marginBottom:5}}>{sw?'Gusa kuanza kusoma bakoodi':'Tap to scan a barcode'}</div>
          <div style={{color:W3,fontSize:12}}>{sw?'Elekeza kamera kwenye bakoodi':'Point your camera at a product barcode'}</div>
        </div>
      )}
      {scanning&&(
        <div style={{position:'relative',borderRadius:16,overflow:'hidden',marginBottom:12,background:'#000'}}>
          <video ref={videoRef} muted playsInline style={{width:'100%',display:'block',maxHeight:280,objectFit:'cover'}}/>
          <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',pointerEvents:'none'}}><div style={{width:'72%',height:70,border:'2px solid rgba(255,255,255,0.7)',borderRadius:8}}/></div>
          <button className="bg" onClick={function(){setScanning(false);}} style={{position:'absolute',bottom:12,left:12,right:12,width:'auto'}}>Cancel</button>
        </div>
      )}
      {loading&&(<Card><div style={{color:W2,fontSize:11,letterSpacing:'0.12em',textTransform:'uppercase',marginBottom:12,textAlign:'center'}}>Looking up product</div><div style={{height:1,background:C3,overflow:'hidden',position:'relative',borderRadius:1}}><div style={{position:'absolute',top:0,left:0,height:'100%',background:W,animation:'scanLine 1.4s ease-in-out infinite',width:'45%',borderRadius:1}}/></div></Card>)}
      {camError&&<div style={{background:C1,border:'1px solid '+BD2,borderRadius:12,padding:14,color:W2,marginBottom:12,fontSize:13,lineHeight:1.5}}>{camError}</div>}
    </div>
  );
}

function Log(props){
  var log=props.log,setLog=props.setLog,lang=props.lang,showToast=props.showToast,userId=props.userId,foods=props.foods||[],restaurants=props.restaurants||[],recentFoods=props.recentFoods||[],addToLog=props.addToLog,savedMeals=props.savedMeals||[],saveMeal=props.saveMeal,deleteSavedMeal=props.deleteSavedMeal,logSavedMeal=props.logSavedMeal;
  var [savingMeal,setSavingMeal]=useState(false);
  var [mealName,setMealName]=useState('');
  var [loggingSaved,setLoggingSaved]=useState(false);
  var [meal,setMeal]=useState('breakfast');
  var [adding,setAdding]=useState(false);
  var [src,setSrc]=useState('foods');
  var [search,setSearch]=useState('');
  var [restSearch,setRestSearch]=useState('');
  var [openRest,setOpenRest]=useState(null);
  var [restGrp,setRestGrp]=useState('All');
  var [pending,setPending]=useState(null);
  var [qty,setQty]=useState(1);
  var [logging,setLogging]=useState(false);
  var [quickText,setQuickText]=useState('');
  var [quickLoading,setQuickLoading]=useState(false);
  var [quickItems,setQuickItems]=useState(null);
  var [quickError,setQuickError]=useState(null);
  var [searchResults,setSearchResults]=useState(null);
  var [searching,setSearching]=useState(false);
  var sw=lang==='sw';
  var mlEn={breakfast:'Breakfast',lunch:'Lunch',dinner:'Dinner',snacks:'Snacks'};
  var mlSw={breakfast:'Kifungua',lunch:'Mchana',dinner:'Jioni',snacks:'Vitafunio'};
  useEffect(function(){
    // Trigram search runs server-side (pg_trgm) so it stays fast as the
    // food table grows past what a client-side substring filter can handle
    // — debounced so we're not firing an RPC on every keystroke. Clearing
    // the search box resets search/searching from the input's own onChange
    // instead of here, so this effect never needs to setState synchronously
    // (setSearching itself is deferred into the timeout callback for the
    // same reason).
    if(!search)return;
    var t=setTimeout(function(){
      setSearching(true);
      supabase.rpc('search_foods',{q:search}).then(function(res){
        if(res.error){console.error(res.error);logError('food-search',res.error);setSearchResults([]);setSearching(false);return;}
        var mapped=(res.data||[]).map(function(x){return{id:x.id,n:x.name_en,s:x.name_sw,e:Number(x.calories),p:Number(x.protein),c:Number(x.carbs),f:Number(x.fat),pr:x.portion,cat:x.category};});
        setSearchResults(mapped);setSearching(false);
      });
    },250);
    return function(){clearTimeout(t);};
  },[search]);
  var filteredRests=restaurants.filter(function(r){
    var matchGrp=restGrp==='All'||r.g===restGrp;
    if(!matchGrp)return false;
    if(!restSearch)return true;
    var q=restSearch.toLowerCase();
    return r.name.toLowerCase().includes(q)||r.items.some(function(item){return item.n.toLowerCase().includes(q);});
  });
  async function add(food){
    if(logging)return;
    setLogging(true);
    await addToLog(meal,food);
    showToast(food.n+' added');setSearch('');setAdding(false);setPending(null);setQty(1);setLogging(false);
  }
  function openQty(food){setPending(food);setQty(1);}
  function scaledFood(food,q){
    return Object.assign({},food,{
      e:Math.round((food.e||0)*q),
      p:Math.round((food.p||0)*q*10)/10,
      c:Math.round((food.c||0)*q*10)/10,
      f:Math.round((food.f||0)*q*10)/10,
      pr:q===1?food.pr:(q+'× '+(food.pr||'serving')),
    });
  }
  async function rm(key,k){
    var item=log[key].find(function(x){return x._k===k;});
    setLog(function(l){var n=Object.assign({},l);n[key]=l[key].filter(function(x){return x._k!==k;});return n;});
    if(!item||!userId)return;
    if(!item.db_id){
      // Never made it to the server (still queued offline) — cancel the
      // pending insert instead of issuing a delete for a row that may not
      // exist yet.
      cancelQueued(function(q){return q.label==='food-log-insert'&&q.payload._k===k;});
      return;
    }
    if(!navigator.onLine){queueWrite('food-log-delete',{id:item.db_id});return;}
    try{
      var res=await supabase.from('food_logs').delete().eq('id',item.db_id);
      if(res.error)throw res.error;
    }catch(e){console.error(e);logError('food-log-delete',e,userId);queueWrite('food-log-delete',{id:item.db_id});showToast("Offline — delete will sync automatically");}
  }
  async function quickAdd(){
    if(!quickText.trim())return;
    setQuickLoading(true);setQuickError(null);setQuickItems(null);
    try{
      var session=(await supabase.auth.getSession()).data.session;
      var data=await fetchJSON('/api/claude',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(session&&session.access_token)},body:JSON.stringify({action:'quickadd',description:quickText})});
      if(data.error)throw new Error(data.error.message||'Could not parse description');
      var txt=data.content.map(function(i){return i.text||'';}).join('');
      var parsed=JSON.parse(txt);
      setQuickItems(parsed.items||[]);
    }catch(e){
      var timedOut=e.message&&e.message.indexOf('timed out')>-1;
      track('ai_request_failed',{action:'quickadd',reason:timedOut?'timeout':'error'});
      setQuickError(timedOut?e.message:'Could not parse that. Try rephrasing.');
    }
    setQuickLoading(false);
  }
  var kcal=log[meal].reduce(function(a,i){return a+i.e;},0);
  return(
    <div className="page" style={{padding:'24px 20px 100px',fontFamily:FF}}>
      <div style={{fontSize:24,fontWeight:800,color:W,letterSpacing:'-0.03em',marginBottom:20}}>Food Log</div>
      <div style={{display:'flex',gap:6,marginBottom:18,overflowX:'auto',paddingBottom:2}}>
        {['breakfast','lunch','dinner','snacks'].map(function(m){var active=meal===m;return(<button key={m} className="pill" onClick={function(){setMeal(m);}} style={{border:'1px solid '+(active?W:BD),background:active?W:'transparent',color:active?BG:W2,padding:'7px 14px'}}>{sw?mlSw[m]:mlEn[m]}</button>);})}
      </div>
      <Card>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
          <Lbl ch={sw?mlSw[meal]:mlEn[meal]}/>
          <span style={{color:kcal>0?W:W3,fontSize:13,fontWeight:600}}>{kcal>0?kcal+' kcal':'empty'}</span>
        </div>
        {log[meal].length===0
          ?<div style={{display:'flex',flexDirection:'column',alignItems:'center',padding:'20px 0',gap:8}}><IcPlus s={24} c={C4}/><div style={{color:W3,fontSize:13,letterSpacing:'0.04em'}}>Nothing logged yet</div></div>
          :log[meal].map(function(item,i,arr){return(<div key={item._k||i}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'11px 0'}}><div style={{flex:1,marginRight:12}}><div style={{color:W,fontSize:14,fontWeight:500}}>{sw?item.s:item.n}</div><div style={{color:W3,fontSize:11,marginTop:2}}>{item.pr}</div></div><div style={{display:'flex',alignItems:'center',gap:10}}><div style={{textAlign:'right'}}><div style={{color:W,fontSize:13,fontWeight:600}}>{item.e} kcal</div><div style={{color:W3,fontSize:10,marginTop:2}}>{item.p}P · {item.c}C · {item.f}F</div></div><button onClick={function(){rm(meal,item._k);}} aria-label={'Remove '+item.n} style={{background:'none',border:'none',cursor:'pointer',padding:4,display:'flex'}}><IcX s={14} c={W3}/></button></div></div>{i<arr.length-1&&<Sep/>}</div>);})}
        {log[meal].length>0&&(savingMeal?(
          <div style={{marginTop:14}}>
            <input value={mealName} onChange={function(e){setMealName(e.target.value);}} autoFocus placeholder={sw?'Jina la mlo, mfano "Kifungua Kinywa Changu"':'Meal name, e.g. "My Usual Breakfast"'} style={{width:'100%',padding:'11px 13px',background:C2,border:'1px solid '+BD,borderRadius:8,color:W,fontSize:14,outline:'none',boxSizing:'border-box',fontFamily:FF,marginBottom:10}}/>
            <div style={{display:'flex',gap:8}}>
              <button className="bp" disabled={!mealName.trim()} onClick={async function(){await saveMeal(mealName.trim(),log[meal]);setSavingMeal(false);setMealName('');}}>{sw?'Hifadhi':'Save'}</button>
              <button className="bg" onClick={function(){setSavingMeal(false);setMealName('');}}>{sw?'Ghairi':'Cancel'}</button>
            </div>
          </div>
        ):(
          <button className="bg" onClick={function(){setSavingMeal(true);}} style={{marginTop:14}}>{sw?'+ Hifadhi kama Mlo':'+ Save as Meal'}</button>
        ))}
      </Card>
      {recentFoods.length>0&&!adding&&!pending&&(
        <Card>
          <Lbl ch={sw?'Vilivyotumika Hivi Karibuni':'Recent'} style={{marginBottom:12}}/>
          <div style={{display:'flex',gap:8,overflowX:'auto',paddingBottom:2}}>
            {recentFoods.map(function(f,i){return(<button key={f.n+i} className="pill" disabled={logging} onClick={function(){add(Object.assign({},f));}} style={{border:'1px solid '+BD,background:C2,color:W,padding:'9px 14px',flexShrink:0,textAlign:'left',display:'flex',flexDirection:'column',gap:2,opacity:logging?0.5:1}}><span style={{fontWeight:600}}>{sw?f.s:f.n}</span><span style={{color:W3,fontSize:10,fontWeight:400}}>{f.e} kcal</span></button>);})}
          </div>
        </Card>
      )}
      {pending&&(
        <Card style={{border:'1px solid '+BD2}}>
          <Lbl ch={sw?'Rekebisha Kiasi':'Adjust Portion'} style={{marginBottom:10}}/>
          <div style={{color:W,fontSize:15,fontWeight:600,marginBottom:16}}>{sw?pending.s:pending.n}</div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:20,marginBottom:16}}>
            <button onClick={function(){setQty(function(q){return Math.max(0.25,Math.round((q-0.25)*100)/100);});}} aria-label="Decrease quantity" style={{width:40,height:40,borderRadius:20,background:C2,border:'1px solid '+BD,color:W,fontSize:18,fontWeight:700,cursor:'pointer',fontFamily:FF}}>−</button>
            <div style={{color:W,fontSize:22,fontWeight:800,minWidth:56,textAlign:'center',fontVariantNumeric:'tabular-nums'}}>{qty}×</div>
            <button onClick={function(){setQty(function(q){return Math.min(20,Math.round((q+0.25)*100)/100);});}} aria-label="Increase quantity" style={{width:40,height:40,borderRadius:20,background:C2,border:'1px solid '+BD,color:W,fontSize:18,fontWeight:700,cursor:'pointer',fontFamily:FF}}>+</button>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:18}}>
            {[{l:'Cal',v:Math.round(pending.e*qty)},{l:'Protein',v:Math.round(pending.p*qty)},{l:'Carbs',v:Math.round(pending.c*qty)},{l:'Fat',v:Math.round(pending.f*qty)}].map(function(m){return(<div key={m.l} style={{background:C2,border:'1px solid '+BD,borderRadius:10,padding:'10px 6px',textAlign:'center'}}><Lbl ch={m.l} style={{marginBottom:4,fontSize:9}}/><div style={{color:W,fontSize:14,fontWeight:700}}>{m.v}</div></div>);})}
          </div>
          <div style={{display:'flex',gap:8}}>
            <button className="bp" disabled={logging} onClick={function(){add(scaledFood(pending,qty));}}>{logging?(sw?'Inaongeza...':'Adding...'):(sw?'Ongeza':'Add')}</button>
            <button className="bg" onClick={function(){setPending(null);setQty(1);}}>{sw?'Ghairi':'Cancel'}</button>
          </div>
        </Card>
      )}
      {adding?(
        <Card>
          <div style={{display:'flex',gap:6,marginBottom:16,overflowX:'auto',paddingBottom:2}}>
            {[{v:'foods',l:sw?'Vyakula':'Foods'},{v:'restaurant',l:sw?'Migahawa':'Restaurants'},{v:'quick',l:sw?'Andika':'Quick Add'},{v:'barcode',l:sw?'Bakoodi':'Barcode'},{v:'saved',l:sw?'Milo Iliyohifadhiwa':'Saved Meals'}].map(function(t){var active=src===t.v;return(<button key={t.v} className="pill" onClick={function(){setSrc(t.v);}} style={{border:'1px solid '+(active?W:BD),background:active?W:'transparent',color:active?BG:W2,padding:'7px 12px',flexShrink:0}}>{t.l}</button>);})}
          </div>
          {src==='foods'&&(
            <div>
              <input value={search} onChange={function(e){var v=e.target.value;setSearch(v);if(!v){setSearchResults(null);setSearching(false);}}} autoFocus placeholder={sw?'Tafuta vyakula vya Kenya...':'Search Kenyan foods...'} style={{width:'100%',padding:'11px 13px',background:C2,border:'1px solid '+BD,borderRadius:8,color:W,fontSize:14,outline:'none',boxSizing:'border-box',fontFamily:FF,marginBottom:10}}/>
              {foods.length===0&&<div style={{color:W3,fontSize:13,textAlign:'center',padding:'16px 0'}}>Loading foods...</div>}
              {search&&searching&&<div style={{color:W3,fontSize:13,textAlign:'center',padding:'16px 0'}}>Searching...</div>}
              {search&&!searching&&searchResults&&searchResults.length===0&&<div style={{color:W3,fontSize:13,textAlign:'center',padding:'16px 0'}}>No foods found.</div>}
              {(search?(searching?[]:(searchResults||[])):foods.slice(0,8)).map(function(f,i,arr){return(<div key={f.id}><button className="fr" onClick={function(){openQty(f);}}><div><div style={{color:W,fontSize:14,fontWeight:500}}>{sw?f.s:f.n}</div><div style={{color:W3,fontSize:11,marginTop:2}}>{f.pr} · {f.cat}</div></div><div style={{textAlign:'right',flexShrink:0,marginLeft:10}}><div style={{color:W,fontSize:13,fontWeight:600}}>{f.e} kcal</div><div style={{color:W2,fontSize:11}}>{f.p}g P</div></div></button>{i<arr.length-1&&<Sep/>}</div>);})}
            </div>
          )}
          {src==='restaurant'&&(
            <div>
              <input value={restSearch} onChange={function(e){setRestSearch(e.target.value);setOpenRest(null);}} placeholder="Search restaurants or dishes..." style={{width:'100%',padding:'11px 13px',background:C2,border:'1px solid '+BD,borderRadius:8,color:W,fontSize:14,outline:'none',boxSizing:'border-box',fontFamily:FF,marginBottom:12}}/>
              <div style={{display:'flex',gap:5,overflowX:'auto',paddingBottom:4,marginBottom:14}}>
                {REST_GROUPS.map(function(g){var active=restGrp===g;return(<button key={g} className="pill" onClick={function(){setRestGrp(g);setOpenRest(null);}} style={{border:'1px solid '+(active?W:BD),background:active?W:'transparent',color:active?BG:W2,padding:'6px 12px',fontSize:11,whiteSpace:'nowrap'}}>{g}</button>);})}
              </div>
              {restaurants.length===0&&<div style={{color:W3,fontSize:13,textAlign:'center',padding:'16px 0'}}>Loading restaurants...</div>}
              {filteredRests.length===0&&restaurants.length>0&&<div style={{color:W3,fontSize:13,textAlign:'center',padding:'16px 0'}}>No results found.</div>}
              {filteredRests.map(function(r){
                var isOpen=openRest===r.name;
                var displayItems=restSearch?r.items.filter(function(item){return item.n.toLowerCase().includes(restSearch.toLowerCase());}).slice(0,8):r.items;
                return(
                  <div key={r.name} style={{marginBottom:8}}>
                    <button onClick={function(){setOpenRest(isOpen?null:r.name);}} style={{width:'100%',display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 14px',background:isOpen?C2:C3,border:'1px solid '+(isOpen?BD2:BD),borderRadius:isOpen?'12px 12px 0 0':12,cursor:'pointer',fontFamily:FF,transition:'background .15s'}}>
                      <div style={{textAlign:'left'}}>
                        <div style={{color:W,fontSize:13,fontWeight:600}}>{r.name}</div>
                        <div style={{color:W3,fontSize:11,marginTop:2}}>{r.g} · {r.items.length} items</div>
                      </div>
                      <IcChevron s={14} c={W2} down={isOpen}/>
                    </button>
                    {isOpen&&(
                      <div style={{background:C2,border:'1px solid '+BD2,borderTop:'none',borderRadius:'0 0 12px 12px',padding:'4px 0'}}>
                        {displayItems.map(function(item,i,arr){
                          return(
                            <div key={i}>
                              <button className="fr" onClick={function(){openQty({n:item.n,s:item.n,e:item.e,p:item.p,c:item.c,f:item.f,pr:item.pr,cat:'Restaurant'});}} style={{padding:'11px 14px'}}>
                                <div style={{flex:1,marginRight:10}}>
                                  <div style={{color:W,fontSize:13,fontWeight:500}}>{item.n}</div>
                                  <div style={{color:W3,fontSize:10,marginTop:2,letterSpacing:'0.02em'}}>est. values</div>
                                </div>
                                <div style={{textAlign:'right',flexShrink:0}}>
                                  <div style={{color:W,fontSize:13,fontWeight:600}}>{item.e} kcal</div>
                                  <div style={{color:W3,fontSize:10}}>{item.p}g P</div>
                                </div>
                              </button>
                              {i<arr.length-1&&<div style={{height:1,background:BD,margin:'0 14px'}}/>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {src==='quick'&&(
            <div>
              <div style={{color:W2,fontSize:12,marginBottom:10,lineHeight:1.5}}>{sw?'Eleza ulichokula, mfano "chapati mbili na chai"':'Describe what you ate, e.g. "2 chapatis and a cup of tea"'}</div>
              <textarea value={quickText} onChange={function(e){setQuickText(e.target.value);}} autoFocus rows={2} maxLength={500} placeholder={sw?'Andika hapa...':'Type here...'} style={{width:'100%',padding:'11px 13px',background:C2,border:'1px solid '+BD,borderRadius:8,color:W,fontSize:14,outline:'none',boxSizing:'border-box',fontFamily:FF,marginBottom:10,resize:'none'}}/>
              <button className="bp" onClick={quickAdd} disabled={!quickText.trim()||quickLoading} style={{marginBottom:12}}>{quickLoading?(sw?'Inachambua...':'Analyzing...'):(sw?'Chambua kwa AI':'Parse with AI')}</button>
              {quickLoading&&(<div style={{height:1,background:C3,overflow:'hidden',position:'relative',borderRadius:1,marginBottom:12}}><div style={{position:'absolute',top:0,left:0,height:'100%',background:W,animation:'scanLine 1.4s ease-in-out infinite',width:'45%',borderRadius:1}}/></div>)}
              {quickError&&<div style={{color:W2,fontSize:13,marginBottom:12}}>{quickError}</div>}
              {quickItems&&quickItems.length===0&&<div style={{color:W3,fontSize:13,textAlign:'center',padding:'12px 0'}}>No foods recognized. Try rephrasing.</div>}
              {quickItems&&quickItems.map(function(item,i,arr){return(<div key={i}><button className="fr" onClick={function(){openQty({n:item.food,s:item.food,e:item.calories,p:item.protein,c:item.carbs,f:item.fat,pr:item.portion,cat:'Quick Add'});setQuickItems(null);setQuickText('');}}><div><div style={{color:W,fontSize:14,fontWeight:500}}>{item.food}</div><div style={{color:W3,fontSize:11,marginTop:2}}>{item.portion}</div></div><div style={{textAlign:'right',flexShrink:0,marginLeft:10}}><div style={{color:W,fontSize:13,fontWeight:600}}>{item.calories} kcal</div><div style={{color:W2,fontSize:11}}>{item.protein}g P</div></div></button>{i<arr.length-1&&<Sep/>}</div>);})}
            </div>
          )}
          {src==='barcode'&&<BarcodeScan lang={lang} showToast={showToast} onFound={openQty}/>}
          {src==='saved'&&(
            <div>
              {savedMeals.length===0&&<div style={{color:W3,fontSize:13,textAlign:'center',padding:'16px 0'}}>{sw?'Hakuna milo iliyohifadhiwa bado. Hifadhi mlo kutoka kwenye orodha ya leo.':'No saved meals yet. Save one from a meal you\'ve already logged today.'}</div>}
              {savedMeals.map(function(m,i,arr){
                var totalE=m.items.reduce(function(a,x){return a+(x.e||0);},0);
                return(
                  <div key={m.id}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'11px 0'}}>
                      <button className="fr" disabled={loggingSaved} onClick={async function(){setLoggingSaved(true);await logSavedMeal(meal,m);showToast(m.name+' added');setAdding(false);setLoggingSaved(false);}} style={{padding:0,flex:1}}>
                        <div style={{flex:1,marginRight:10}}><div style={{color:W,fontSize:14,fontWeight:500}}>{m.name}</div><div style={{color:W3,fontSize:11,marginTop:2}}>{m.items.length} item{m.items.length!==1?'s':''}</div></div>
                        <div style={{color:W,fontSize:13,fontWeight:600,flexShrink:0}}>{totalE} kcal</div>
                      </button>
                      <button onClick={function(){deleteSavedMeal(m.id);}} aria-label={'Delete '+m.name} style={{background:'none',border:'none',cursor:'pointer',padding:'4px 0 4px 10px',display:'flex',flexShrink:0}}><IcX s={14} c={W3}/></button>
                    </div>
                    {i<arr.length-1&&<Sep/>}
                  </div>
                );
              })}
            </div>
          )}
          <div style={{marginTop:16}}><button className="bg" onClick={function(){setAdding(false);setSrc('foods');setSearch('');setRestSearch('');setOpenRest(null);setRestGrp('All');setQuickText('');setQuickItems(null);setQuickError(null);}}>Cancel</button></div>
        </Card>
      ):(
        <button className="bp" onClick={function(){setAdding(true);}}>+ Add Food</button>
      )}
    </div>
  );
}

// ── SCAN ──────────────────────────────────────────────────
function Scan(props){
  var addToLog=props.addToLog,lang=props.lang,showToast=props.showToast;
  var [img,setImg]=useState(null);
  var [loading,setLoading]=useState(false);
  var [result,setResult]=useState(null);
  var [error,setError]=useState(null);
  var [meal,setMeal]=useState('lunch');
  var [done,setDone]=useState(false);
  var ref=useRef();
  var sw=lang==='sw';
  async function analyze(imgData){
    var src=imgData||img;
    if(!src)return;setLoading(true);setError(null);
    var b64=src.split(',')[1],mt=src.split(';')[0].split(':')[1];
    try{
      var session=(await supabase.auth.getSession()).data.session;
      var data=await fetchJSON('/api/claude',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(session&&session.access_token)},body:JSON.stringify({action:'scan',image:{mediaType:mt,data:b64}})});
      if(data.error)throw new Error(data.error.message||'Analysis failed');
      var txt=data.content.map(function(i){return i.text||'';}).join('');
      setResult(JSON.parse(txt));setLoading(false);
    }catch(e){
      var timedOut=e.message&&e.message.indexOf('timed out')>-1;
      track('ai_request_failed',{action:'scan',reason:timedOut?'timeout':'error'});
      setError(timedOut?e.message:'Analysis failed. Try a clearer photo.');setLoading(false);
    }
  }
  function confirm(){
    if(!result)return;
    addToLog(meal,{n:result.food,s:result.food,e:result.calories,p:result.protein,c:result.carbs,f:result.fat,pr:result.portion,cat:'AI Scan'});
    showToast(result.food+' added to '+meal);
    setDone(true);setTimeout(function(){setImg(null);setResult(null);setDone(false);},1800);
  }
  return(
    <div className="page" style={{padding:'24px 20px 100px',fontFamily:FF}}>
      <div style={{fontSize:24,fontWeight:800,color:W,letterSpacing:'-0.03em',marginBottom:6}}>{sw?'Skani ya AI':'AI Scanner'}</div>
      <div style={{color:W2,fontSize:13,marginBottom:20,lineHeight:1.5}}>Photograph your meal for instant nutritional analysis</div>
      <div style={{display:'flex',gap:6,marginBottom:20,flexWrap:'wrap'}}>{['breakfast','lunch','dinner','snacks'].map(function(m){var active=meal===m;return(<button key={m} className="pill" onClick={function(){setMeal(m);}} style={{border:'1px solid '+(active?W:BD),background:active?W:'transparent',color:active?BG:W2,padding:'7px 12px',textTransform:'capitalize'}}>{m}</button>);})}</div>
      <input ref={ref} type="file" accept="image/*" capture="environment" onChange={function(e){
        var file=e.target.files[0];
        e.target.value='';
        if(!file)return;
        setResult(null);setError(null);setDone(false);setImg(null);setLoading(true);
        var reader=new FileReader();
        reader.onload=async function(ev){
          var resized=await resizeImage(ev.target.result,1024);
          setImg(resized);
          analyze(resized);
        };
        reader.onerror=function(){setLoading(false);setError('Could not read that photo. Try again.');};
        reader.readAsDataURL(file);
      }} style={{display:'none'}}/>
      {done&&<div style={{background:C1,border:'1px solid '+BD2,borderRadius:16,padding:28,textAlign:'center',marginBottom:12}}><div style={{color:W,fontSize:16,fontWeight:700}}>Added to {meal}.</div></div>}
      {!img&&!done&&!loading&&(<div onClick={function(){ref.current.click();}} style={{border:'1px dashed '+BD2,borderRadius:16,padding:44,textAlign:'center',cursor:'pointer',marginBottom:12}}><div style={{display:'flex',justifyContent:'center',marginBottom:14}}><IcScan s={32} c={W3}/></div><div style={{color:W,fontSize:15,fontWeight:600,marginBottom:5}}>{sw?'Gusa hapa kupiga picha':'Tap to photograph your meal'}</div><div style={{color:W3,fontSize:12}}>{sw?'au chagua kutoka galari':'or select from gallery'}</div></div>)}
      {img&&!done&&(<div style={{marginBottom:12}}><div style={{position:'relative'}}><img src={img} alt="Food" style={{width:'100%',borderRadius:16,maxHeight:260,objectFit:'cover',display:'block'}}/></div><button className="bg" onClick={function(){setImg(null);setResult(null);setError(null);}} style={{marginTop:8,width:'auto',padding:'8px 14px'}}>Retake</button></div>)}
      {img&&error&&!loading&&!done&&<button className="bp" onClick={function(){analyze(img);}} style={{marginBottom:10}}>Retry Analysis</button>}
      {loading&&(<Card><div style={{color:W2,fontSize:11,letterSpacing:'0.12em',textTransform:'uppercase',marginBottom:12,textAlign:'center'}}>Analyzing your meal</div><div style={{height:1,background:C3,overflow:'hidden',position:'relative',borderRadius:1}}><div style={{position:'absolute',top:0,left:0,height:'100%',background:W,animation:'scanLine 1.4s ease-in-out infinite',width:'45%',borderRadius:1}}/></div></Card>)}
      {error&&<div style={{background:C1,border:'1px solid '+BD2,borderRadius:12,padding:14,color:W2,marginBottom:12,fontSize:13,lineHeight:1.5}}>{error}</div>}
      {result&&!done&&(<Card><div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:18}}><div style={{flex:1,marginRight:10}}><div style={{color:W,fontSize:17,fontWeight:700,letterSpacing:'-0.02em',lineHeight:1.2}}>{result.food}</div><div style={{color:W2,fontSize:12,marginTop:4}}>{result.portion}{result.budgetKES?' · ~KES '+result.budgetKES:''}</div></div><span style={{background:C2,border:'1px solid '+BD,borderRadius:20,padding:'4px 10px',flexShrink:0,color:W2,fontSize:10,fontWeight:600,letterSpacing:'0.06em',textTransform:'uppercase'}}>{result.confidence}</span></div><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:18}}>{[{l:'Calories',v:result.calories,u:'kcal'},{l:'Protein',v:result.protein,u:'g'},{l:'Carbs',v:result.carbs,u:'g'},{l:'Fat',v:result.fat,u:'g'}].map(function(m){return(<div key={m.l} style={{background:C2,border:'1px solid '+BD,borderRadius:10,padding:'12px'}}><Lbl ch={m.l} style={{marginBottom:5}}/><div style={{color:W,fontSize:20,fontWeight:700,letterSpacing:'-0.02em'}}>{m.v}<span style={{fontSize:11,color:W3,fontWeight:400}}> {m.u}</span></div></div>);})}</div>{result.notes&&<div style={{color:W2,fontSize:12,marginBottom:18,lineHeight:1.6}}>{result.notes}</div>}<button className="bp" onClick={confirm}>Add to {meal.charAt(0).toUpperCase()+meal.slice(1)}</button></Card>)}
    </div>
  );
}

// ── METRICS ───────────────────────────────────────────────
function Metrics(props){
  var profile=props.profile,setProfile=props.setProfile,metrics=props.metrics,setMetrics=props.setMetrics,score=props.score,lang=props.lang,showToast=props.showToast,userId=props.userId,targets=props.targets,setTargets=props.setTargets;
  var [form,setForm]=useState(false);
  var [nw,setNw]=useState('');
  var [meas,setMeas]=useState({waist:'',chest:'',hips:'',neck:''});
  var [recal,setRecal]=useState(null);
  var sw=lang==='sw';
  async function save(){
    if(!nw)return;
    var newWeight=parseFloat(nw);
    var entry=Object.assign({date:new Date().toLocaleDateString('en-KE'),weight:newWeight},meas);
    setMetrics(function(m){return m.concat([entry]);});
    // Keep profile.weight current — it feeds the BMR/maintenance calc behind
    // Smart Recalibration and is shown on the Profile screen, so a stale
    // onboarding-day weight would silently skew both over time.
    setProfile(function(p){return Object.assign({},p,{weight:newWeight});});
    if(userId){
      var metricPayload={user_id:userId,date:today(),weight:newWeight||null,waist:parseFloat(meas.waist)||null,chest:parseFloat(meas.chest)||null,hips:parseFloat(meas.hips)||null,neck:parseFloat(meas.neck)||null};
      if(!navigator.onLine){
        queueWrite('body-metrics-insert',metricPayload);
        queueWrite('profile-weight-update',{userId:userId,weight:newWeight});
        showToast('Saved offline — will sync automatically');
      }else{
        try{
          var res=await supabase.from('body_metrics').insert(metricPayload);
          if(res.error)throw res.error;
          var pRes=await supabase.from('profiles').update({weight:newWeight}).eq('id',userId);
          if(pRes.error)throw pRes.error;
          showToast('Metrics saved');
        }catch(e){
          console.error(e);logError('body-metrics-save',e,userId);
          queueWrite('body-metrics-insert',metricPayload);
          queueWrite('profile-weight-update',{userId:userId,weight:newWeight});
          showToast("Couldn't save — will retry automatically");
        }
      }
    }else{showToast('Metrics saved');}
    setNw('');setMeas({waist:'',chest:'',hips:'',neck:''});setForm(false);
  }
  var targetCalories=targets?targets.calories:null;
  useEffect(function(){
    if(!userId||!profile||!targetCalories)return;
    var cutoff=new Date();cutoff.setDate(cutoff.getDate()-28);
    var cutoffStr=localDateStr(cutoff);
    Promise.all([
      supabase.from('food_logs').select('date,calories').eq('user_id',userId).gte('date',cutoffStr),
      supabase.from('body_metrics').select('date,weight').eq('user_id',userId).gte('date',cutoffStr).order('date',{ascending:true})
    ]).then(function(results){
      var logs=(results[0].data||[]),weights=(results[1].data||[]).filter(function(w){return w.weight;});
      var byDate={};
      logs.forEach(function(r){byDate[r.date]=(byDate[r.date]||0)+Number(r.calories||0);});
      var loggedDates=Object.keys(byDate);
      if(loggedDates.length<7||weights.length<2){setRecal(null);return;}
      var firstW=weights[0],lastW=weights[weights.length-1];
      var days=(new Date(lastW.date)-new Date(firstW.date))/86400000;
      if(days<7){setRecal(null);return;}
      var t0=new Date(firstW.date).getTime();
      var slope=weightTrendSlope(weights.map(function(w){return{x:(new Date(w.date).getTime()-t0)/86400000,y:Number(w.weight)};}));
      var deltaWeight=slope*days;
      var avgIntake=loggedDates.reduce(function(a,d){return a+byDate[d];},0)/loggedDates.length;
      var actualMaintenance=Math.round(avgIntake-(deltaWeight*7700)/days);
      var assumedMaintenance=Math.round(calcMaintenance(profile));
      var goalOffset=targetCalories-assumedMaintenance;
      var suggestedCalories=Math.max(1200,Math.round(actualMaintenance+goalOffset));
      if(Math.abs(suggestedCalories-targetCalories)<75){setRecal(null);return;}
      track('recalibration_shown',{assumedMaintenance:assumedMaintenance,actualMaintenance:actualMaintenance,suggestedCalories:suggestedCalories});
      setRecal({assumedMaintenance:assumedMaintenance,actualMaintenance:actualMaintenance,suggestedCalories:suggestedCalories,days:Math.round(days),loggedDays:loggedDates.length});
    });
  },[userId,profile,targetCalories]);
  async function applyRecal(){
    track('recalibration_accepted',{suggestedCalories:recal.suggestedCalories});
    var m=macrosFor(profile,recal.suggestedCalories);
    var newTargets={calories:recal.suggestedCalories,protein:m.protein,carbs:m.carbs,fat:m.fat,water:targets.water};
    setTargets(newTargets);
    if(userId){
      try{
        var res=await supabase.from('profiles').update({calories:newTargets.calories,protein:newTargets.protein,carbs:newTargets.carbs,fat:newTargets.fat}).eq('id',userId);
        if(res.error)throw res.error;
        showToast('Targets updated');
      }catch(e){console.error(e);logError('target-update',e,userId);showToast("Couldn't sync target — try again later");}
    }else{showToast('Targets updated');}
    setRecal(null);
  }
  var latest=metrics.length>0?metrics[metrics.length-1]:null;
  var change=metrics.length>1?(parseFloat(metrics[metrics.length-1].weight)-parseFloat(metrics[0].weight)).toFixed(1):null;
  var all10=metrics.slice(-10);
  var currentWeight=parseFloat(latest?latest.weight:profile.weight);
  var toGoal=profile.targetWeight?Math.abs(currentWeight-profile.targetWeight).toFixed(1):null;
  var maxW=all10.length>1?Math.max.apply(null,all10.map(function(m){return m.weight;})):null;
  var minW=all10.length>1?Math.min.apply(null,all10.map(function(m){return m.weight;})):null;
  return(
    <div className="page" style={{padding:'24px 20px 100px',fontFamily:FF}}>
      <div style={{fontSize:24,fontWeight:800,color:W,letterSpacing:'-0.03em',marginBottom:20}}>{sw?'Vipimo vya Mwili':'Body Metrics'}</div>
      {recal&&(<Card style={{border:'1px solid '+BD2}}>
        <Lbl ch={sw?'Urekebishaji wa Akili':'Smart Recalibration'} style={{marginBottom:10}}/>
        <div style={{color:W2,fontSize:13,lineHeight:1.6,marginBottom:16}}>{sw?'Kulingana na':'Based on'} {recal.loggedDays} {sw?'siku za rekodi katika siku':'days of logs over the last'} {recal.days} {sw?'zilizopita, matumizi yako halisi yanaonekana':'days, your real maintenance looks like'} <span style={{color:W,fontWeight:700}}>{recal.actualMaintenance} kcal</span>{sw?' — mpango wako ulidhania ':' — your plan assumed '}{recal.assumedMaintenance} kcal.</div>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',marginBottom:18}}>
          <div><Lbl ch={sw?'Lengo Linalopendekezwa':'Suggested Target'} style={{marginBottom:4}}/><div style={{color:W,fontSize:26,fontWeight:800,letterSpacing:'-0.02em'}}>{recal.suggestedCalories}<span style={{fontSize:13,color:W3,fontWeight:400}}> kcal</span></div></div>
          <div style={{textAlign:'right'}}><Lbl ch={sw?'Sasa':'Current'} style={{marginBottom:4}}/><div style={{color:W3,fontSize:16,fontWeight:600}}>{targets.calories}<span style={{fontSize:12}}> kcal</span></div></div>
        </div>
        <div style={{display:'flex',gap:8}}><button className="bp" onClick={applyRecal}>{sw?'Sasisha Lengo':'Update My Target'}</button><button className="bg" onClick={function(){track('recalibration_dismissed');setRecal(null);}}>{sw?'Sio Sasa':'Not Now'}</button></div>
      </Card>)}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:12}}><StatBox label={sw?'Uzito':'Weight'} value={(latest?latest.weight:profile.weight)+''} sub="kg"/><StatBox label={sw?'Mabadiliko':'Change'} value={change!==null?(Number(change)>0?'+':'')+change:'-'} sub="kg total"/><StatBox label="Score" value={score+''} sub="/ 100"/></div>
      {toGoal!==null&&(<Card style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><div><Lbl ch={sw?'Lengo':'Goal Weight'} style={{marginBottom:4}}/><div style={{color:W,fontSize:14,fontWeight:600}}>{profile.targetWeight} kg</div></div><div style={{textAlign:'right'}}><Lbl ch={sw?'Iliyobaki':'To Go'} style={{marginBottom:4}}/><div style={{color:W,fontSize:18,fontWeight:800}}>{Number(toGoal)===0?(sw?'Umefika!':'Reached!'):toGoal+' kg'}</div></div></Card>)}
      {all10.length>1&&(<Card><Lbl ch="Weight Trend" style={{marginBottom:14}}/><div style={{display:'flex',alignItems:'flex-end',gap:4,height:72}}>{all10.map(function(m,i){var h=maxW===minW?50:Math.max(((m.weight-minW)/(maxW-minW))*60+12,8);var isLatest=i===all10.length-1;return(<div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:3}}><div style={{width:'100%',height:h+'px',background:isLatest?W:C3,borderRadius:'3px 3px 0 0',transition:'height .5s ease'}}/><div style={{color:W3,fontSize:8}}>{m.weight}</div></div>);})}</div></Card>)}
      <Card><Lbl ch="Body Measurements (cm)" style={{marginBottom:14}}/>{latest&&Object.keys(meas).some(function(k){return latest[k];})?<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>{Object.keys(meas).map(function(k){return latest[k]?(<div key={k} style={{background:C2,border:'1px solid '+BD,borderRadius:10,padding:'12px'}}><Lbl ch={k} style={{marginBottom:5}}/><div style={{color:W,fontSize:18,fontWeight:700}}>{latest[k]}<span style={{color:W3,fontSize:11,fontWeight:400}}> cm</span></div></div>):null;})}</div>:<div style={{color:W3,fontSize:12,textAlign:'center',padding:'8px 0',letterSpacing:'0.04em'}}>No measurements logged yet</div>}</Card>
      {metrics.length>0&&(<Card><Lbl ch="History" style={{marginBottom:12}}/>{metrics.slice().reverse().slice(0,6).map(function(m,i,arr){return(<div key={i}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'9px 0'}}><span style={{color:W2,fontSize:13}}>{m.date}</span><span style={{color:W,fontSize:14,fontWeight:600}}>{m.weight} kg</span></div>{i<arr.length-1&&<Sep/>}</div>);})}</Card>)}
      {form?(<Card><Lbl ch="Log Today's Entry" style={{marginBottom:18}}/>{[{k:'_w',label:'Weight',ph:'e.g. 75.5',unit:'kg',v:nw,set:setNw}].concat(Object.keys(meas).map(function(k){return{k:k,label:k.charAt(0).toUpperCase()+k.slice(1),ph:'optional',unit:'cm',v:meas[k],set:function(v){setMeas(function(m){var n=Object.assign({},m);n[k]=v;return n;});}};})).map(function(f){return(<div key={f.k} style={{marginBottom:18}}><div style={{display:'flex',justifyContent:'space-between',marginBottom:7}}><Lbl ch={f.label}/><span style={{color:W3,fontSize:11}}>{f.unit}</span></div><input type="number" value={f.v} onChange={function(e){f.set(e.target.value);}} placeholder={f.ph} autoFocus={f.k==='_w'} style={{width:'100%',padding:'0 0 10px',background:'none',border:'none',borderBottom:'1px solid '+BD2,color:W,fontSize:22,outline:'none',boxSizing:'border-box',fontFamily:FF,fontWeight:600}}/></div>);})}
      <div style={{display:'flex',gap:8}}><button className="bp" onClick={save} disabled={!nw}>{sw?'Hifadhi':'Save'}</button><button className="bg" onClick={function(){setForm(false);}}>{sw?'Ghairi':'Cancel'}</button></div></Card>
      ):(<button className="bp" onClick={function(){setForm(true);}}>+ Log Today</button>)}
    </div>
  );
}

// ── PROFILE ───────────────────────────────────────────────
function Profile(props){
  var profile=props.profile,targets=props.targets,lang=props.lang,setLang=props.setLang,score=props.score,streak=props.streak,onReset=props.onReset,setScore=props.setScore,showToast=props.showToast,userEmail=props.userEmail,userId=props.userId,onLegal=props.onLegal;
  var [plan,setPlan]=useState(null);
  var [planLoad,setPlanLoad]=useState(false);
  var [showPlan,setShowPlan]=useState(false);
  var [checkin,setCheckin]=useState(false);
  var [showAccount,setShowAccount]=useState(false);
  var [newEmail,setNewEmail]=useState('');
  var [emailSent,setEmailSent]=useState(false);
  var [passSent,setPassSent]=useState(false);
  var [pendingSync,setPendingSync]=useState(function(){return queueLength();});
  var [exporting,setExporting]=useState(false);
  var [remindersOn,setRemindersOn]=useState(false);
  var [remindersBusy,setRemindersBusy]=useState(false);
  var sw=lang==='sw';
  var inp={width:'100%',padding:'0 0 12px',background:'none',border:'none',borderBottom:'1px solid '+BD2,color:W,outline:'none',boxSizing:'border-box',fontFamily:FF,fontSize:18};
  useEffect(function(){
    return onQueueChange(setPendingSync);
  },[]);
  useEffect(function(){
    if(!pushSupported())return;
    getPushSubscription().then(function(sub){setRemindersOn(!!sub);}).catch(function(){});
  },[]);
  async function toggleReminders(){
    if(!userId){showToast('Sign in to enable reminders');return;}
    setRemindersBusy(true);
    try{
      if(remindersOn){
        await unsubscribeFromPush();
        setRemindersOn(false);showToast('Reminders turned off');
      }else{
        await subscribeToPush(userId);
        setRemindersOn(true);showToast('Reminders turned on');
      }
    }catch(e){console.error(e);logError('push-toggle',e,userId);showToast(e.message||"Couldn't update reminders");}
    setRemindersBusy(false);
  }
  async function genPlan(){
    setPlanLoad(true);setShowPlan(true);setPlan(null);
    try{
      var session=(await supabase.auth.getSession()).data.session;
      var data=await fetchJSON('/api/claude',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(session&&session.access_token)},body:JSON.stringify({action:'plan',targets:{goal:profile.goal,calories:targets.calories,protein:targets.protein,carbs:targets.carbs,fat:targets.fat,restrictions:profile.restrictions}})},55000);
      if(data.error)throw new Error(data.error.message||'Plan generation failed');
      var txt=data.content.map(function(i){return i.text||'';}).join('');
      setPlan(JSON.parse(txt));setPlanLoad(false);
    }catch(e){
      var timedOut=e.message&&e.message.indexOf('timed out')>-1;
      track('ai_request_failed',{action:'plan',reason:timedOut?'timeout':'error'});
      setPlan({error:true,message:timedOut?e.message:null});setPlanLoad(false);
    }
  }
  async function handleChangePassword(){
    if(!userEmail)return;
    var res=await supabase.auth.resetPasswordForEmail(userEmail,{redirectTo:'https://nutrikenya.vercel.app'});
    if(res.error){showToast(res.error.message);return;}
    setPassSent(true);showToast('Password reset email sent');
  }
  async function handleChangeEmail(){
    var cleanEmail=newEmail.trim();
    if(!cleanEmail){showToast('Enter your new email address.');return;}
    var res=await supabase.auth.updateUser({email:cleanEmail},{emailRedirectTo:'https://nutrikenya.vercel.app'});
    if(res.error){showToast(res.error.message);return;}
    setEmailSent(true);showToast('Confirmation sent to '+cleanEmail);
  }
  async function exportData(){
    if(!userId){showToast('Sign in to export your data');return;}
    setExporting(true);
    try{
      var results=await Promise.all([
        supabase.from('food_logs').select('date,meal,food_name,food_name_sw,calories,protein,carbs,fat,portion').eq('user_id',userId).order('date'),
        supabase.from('body_metrics').select('date,weight,waist,chest,hips,neck').eq('user_id',userId).order('date'),
      ]);
      if(results[0].error)throw results[0].error;
      if(results[1].error)throw results[1].error;
      var logs=results[0].data||[],metrics=results[1].data||[];
      var cols=['type','date','meal','food_name','food_name_sw','calories','protein','carbs','fat','portion','weight','waist','chest','hips','neck'];
      function esc(v){
        if(v===null||v===undefined)return '';
        var s=String(v);
        return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
      }
      var rows=[cols.join(',')];
      logs.forEach(function(r){rows.push(cols.map(function(c){return c==='type'?'food_log':esc(r[c]);}).join(','));});
      metrics.forEach(function(r){rows.push(cols.map(function(c){return c==='type'?'body_metric':esc(r[c]);}).join(','));});
      var blob=new Blob([rows.join('\n')],{type:'text/csv;charset=utf-8;'});
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a');
      a.href=url;a.download='nutrikenya-export-'+today()+'.csv';
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Export downloaded');
    }catch(e){console.error(e);logError('csv-export',e,userId);showToast("Couldn't export — try again");}
    setExporting(false);
  }
  var goalLabel={lose:'Fat Loss',gain:'Muscle Gain',recomp:'Body Recomp',maintain:'Maintenance'}[profile.goal];
  var actLabels=['Sedentary','Light','Moderate','Very Active','Extreme'];
  return(
    <div className="page" style={{padding:'24px 20px 100px',fontFamily:FF}}>
      <div style={{fontSize:24,fontWeight:800,color:W,letterSpacing:'-0.03em',marginBottom:20}}>{sw?'Wasifu':'Profile'}</div>
      {pendingSync>0&&(<div style={{background:C2,border:'1px solid '+BD,borderRadius:10,padding:'10px 14px',color:W2,fontSize:12,marginBottom:12,lineHeight:1.5}}>{pendingSync} {pendingSync===1?'change':'changes'} waiting to sync — will finish automatically when you're back online.</div>)}
      <Card>
        <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:18}}>
          <div style={{width:48,height:48,borderRadius:24,background:W,display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,fontWeight:900,color:BG,flexShrink:0}}>{(profile.name||'U')[0].toUpperCase()}</div>
          <div><div style={{color:W,fontSize:17,fontWeight:700,letterSpacing:'-0.02em'}}>{profile.name}</div><div style={{color:W2,fontSize:12,marginTop:3}}>{profile.weight}kg · {profile.height}cm · {profile.age} yrs</div><div style={{color:W3,fontSize:11,marginTop:3}}>{streak}-day streak · Score {score}/100</div></div>
        </div>
        <Sep/>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:14}}>{[{l:'Goal',v:goalLabel},{l:'Activity',v:actLabels[profile.activity]||'Moderate'},{l:'Training',v:(profile.workoutType||'Mixed').split(' ').slice(0,2).join(' ')},{l:'Diet',v:profile.restrictions||'No restrictions'}].map(function(x,i){return(<div key={i} style={{background:C2,border:'1px solid '+BD,borderRadius:10,padding:'11px'}}><Lbl ch={x.l} style={{marginBottom:4}}/><div style={{color:W,fontSize:12,fontWeight:500,lineHeight:1.3}}>{x.v}</div></div>);})}</div>
      </Card>
      <Card><Lbl ch="Daily Targets" style={{marginBottom:14}}/>{[{l:'Calories',v:targets.calories+' kcal'},{l:'Protein',v:targets.protein+'g'},{l:'Carbs',v:targets.carbs+'g'},{l:'Fat',v:targets.fat+'g'},{l:'Water',v:targets.water+'ml'}].map(function(t,i,arr){return(<div key={i}><div style={{display:'flex',justifyContent:'space-between',padding:'10px 0'}}><span style={{color:W2,fontSize:13}}>{t.l}</span><span style={{color:W,fontSize:13,fontWeight:600}}>{t.v}</span></div>{i<arr.length-1&&<Sep/>}</div>);})}</Card>
      <button className="ic" onClick={exportData} disabled={exporting} style={{marginBottom:10,opacity:exporting?0.6:1}}><span style={{letterSpacing:'-0.01em'}}>{exporting?'Exporting...':'Export My Data (CSV)'}</span><IcArr c={W2}/></button>
      <button className="ic" onClick={function(){setShowAccount(function(v){return!v;});}} style={{marginBottom:10}}><span style={{letterSpacing:'-0.01em'}}>Account Settings</span><IcArr c={W2}/></button>
      {showAccount&&(<Card>
        <Lbl ch="Password" style={{marginBottom:10}}/>
        {passSent?<div style={{color:W2,fontSize:13,lineHeight:1.6,marginBottom:16}}>Reset link sent to <span style={{color:W}}>{userEmail}</span>. Check your email.</div>:<div style={{marginBottom:16}}><div style={{color:W3,fontSize:12,lineHeight:1.6,marginBottom:10}}>We'll send a reset link to <span style={{color:W2}}>{userEmail}</span></div><button className="bg" onClick={handleChangePassword} style={{width:'auto',padding:'10px 18px'}}>Send Reset Link</button></div>}
        <Sep/>
        <div style={{marginTop:16}}>
          <Lbl ch="Change Email" style={{marginBottom:10}}/>
          {emailSent?<div style={{color:W2,fontSize:13,lineHeight:1.6}}>Confirmation sent to <span style={{color:W}}>{newEmail}</span>. Click the link to confirm your new email.</div>:<div><div style={{color:W3,fontSize:12,lineHeight:1.6,marginBottom:12}}>Current: <span style={{color:W2}}>{userEmail}</span></div><input value={newEmail} onChange={function(e){setNewEmail(e.target.value);}} placeholder="New email address" type="email" autoCapitalize="none" autoCorrect="off" spellCheck="false" style={{...inp,marginBottom:12}}/><button className="bg" onClick={handleChangeEmail} style={{width:'auto',padding:'10px 18px'}}>Update Email</button></div>}
        </div>
      </Card>)}
      <Card style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div><Lbl ch="Language / Lugha" style={{marginBottom:4}}/><div style={{color:W,fontSize:14,fontWeight:500}}>English · Kiswahili</div></div>
        <div style={{display:'flex',gap:6}}>{['en','sw'].map(function(l){var active=lang===l;return(<button key={l} className="pill" onClick={function(){setLang(l);}} style={{border:'1px solid '+(active?W:BD),background:active?W:'transparent',color:active?BG:W2,padding:'7px 12px'}}>{l==='en'?'EN':'SW'}</button>);})}</div>
      </Card>
      {pushSupported()&&(<Card style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div><Lbl ch={sw?'Vikumbusho':'Reminders'} style={{marginBottom:4}}/><div style={{color:W,fontSize:14,fontWeight:500}}>{sw?'Kikumbusho cha kila siku cha kurekodi':'Daily nudge to log your meals'}</div></div>
        <button className="pill" disabled={remindersBusy} onClick={toggleReminders} style={{border:'1px solid '+(remindersOn?W:BD),background:remindersOn?W:'transparent',color:remindersOn?BG:W2,padding:'7px 14px',opacity:remindersBusy?0.6:1}}>{remindersOn?'ON':'OFF'}</button>
      </Card>)}
      <button className="ic" onClick={genPlan} style={{marginBottom:10}}><span style={{letterSpacing:'-0.01em'}}>{sw?'Mpango wa Chakula wa AI':'Generate AI Meal Plan'}</span><IcArr c={W2}/></button>
      {showPlan&&(<Card><Lbl ch="Your 3-Day Kenyan Plan" style={{marginBottom:14}}/>{planLoad&&(<div style={{padding:'20px 0'}}><div style={{height:1,background:C3,overflow:'hidden',position:'relative',marginBottom:8,borderRadius:1}}><div style={{position:'absolute',top:0,left:0,height:'100%',background:W,animation:'scanLine 1.4s ease-in-out infinite',width:'45%',borderRadius:1}}/></div><div style={{color:W3,fontSize:11,letterSpacing:'0.08em',textTransform:'uppercase',textAlign:'center'}}>Generating...</div></div>)}{plan&&plan.error&&<div style={{color:W2,fontSize:13}}>{plan.message||'Could not generate. Try again.'}</div>}{plan&&plan.days&&plan.days.map(function(d,i,arr){return(<div key={i} style={{marginBottom:14,paddingBottom:14,borderBottom:i<arr.length-1?'1px solid '+BD:'none'}}><div style={{color:W,fontSize:11,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',marginBottom:8}}>{d.day}</div>{['breakfast','lunch','dinner'].map(function(m){return d[m]?(<div key={m} style={{marginBottom:7}}><span style={{color:W3,fontSize:10,letterSpacing:'0.06em',textTransform:'uppercase',marginRight:7}}>{m}</span><span style={{color:W2,fontSize:13,lineHeight:1.4}}>{d[m]}</span></div>):null;})}{d.calories&&<div style={{color:W3,fontSize:11,marginTop:7}}>~{d.calories} kcal · {d.protein}g protein</div>}{d.tip&&<div style={{color:W2,fontSize:12,marginTop:5,fontStyle:'italic',lineHeight:1.5}}>{d.tip}</div>}</div>);})}
      <button className="bg" onClick={function(){setShowPlan(false);setPlan(null);}}>Close</button></Card>)}
      <button className="ic" onClick={function(){setCheckin(function(v){return!v;});}} style={{marginBottom:10}}><span style={{letterSpacing:'-0.01em'}}>{sw?'Ukaguzi wa Kila Wiki':'Weekly Check-In'}</span><IcArr c={W2}/></button>
      {checkin&&(<Card><Lbl ch="How is your week going?" style={{marginBottom:12}}/>{['Crushing it — great progress','Steady — staying consistent','Struggled a bit this week','Need to adjust my goals'].map(function(opt,i,arr){return(<div key={i}><button className="fr" onClick={function(){setCheckin(false);setScore(function(s){var ns=Math.min(s+5,100);if(userId){supabase.from('profiles').update({score:ns}).eq('id',userId);}return ns;});showToast('Check-in complete +5 pts');}}><span style={{color:W,fontSize:14,fontWeight:500}}>{opt}</span><IcArr s={12} c={W3}/></button>{i<arr.length-1&&<Sep/>}</div>);})}</Card>)}
      <div style={{display:'flex',justifyContent:'center',gap:14,margin:'18px 0 4px'}}><span onClick={function(){onLegal('privacy');}} style={{color:W3,fontSize:11,cursor:'pointer',letterSpacing:'0.04em'}}>Privacy Policy</span><span style={{color:W3,fontSize:11}}>·</span><span onClick={function(){onLegal('terms');}} style={{color:W3,fontSize:11,cursor:'pointer',letterSpacing:'0.04em'}}>Terms of Service</span></div>
      <button onClick={onReset} style={{width:'100%',padding:'13px',background:'transparent',border:'1px solid rgba(255,255,255,0.08)',borderRadius:10,color:W3,fontSize:12,cursor:'pointer',marginTop:4,fontFamily:FF,letterSpacing:'0.06em',textTransform:'uppercase'}}>{sw?'Anza Upya':'Sign Out & Reset'}</button>
    </div>
  );
}

// ── NAV ───────────────────────────────────────────────────
function Nav(props){
  var tab=props.tab,setTab=props.setTab,lang=props.lang;
  var sw=lang==='sw';
  var tabs=[{id:'dashboard',Icon:IcHome,l:sw?'Nyumbani':'Home'},{id:'log',Icon:IcLog,l:sw?'Rekodi':'Log'},{id:'scan',Icon:IcScan,l:sw?'Skani':'Scan'},{id:'metrics',Icon:IcChart,l:sw?'Vipimo':'Metrics'},{id:'profile',Icon:IcUser,l:sw?'Wasifu':'Profile'}];
  return(<div style={{position:'fixed',bottom:0,left:0,right:0,background:'rgba(7,7,7,0.97)',borderTop:'1px solid '+BD,display:'flex',zIndex:100,backdropFilter:'blur(20px)',WebkitBackdropFilter:'blur(20px)',paddingBottom:'env(safe-area-inset-bottom)'}}>{tabs.map(function(t){var active=tab===t.id;return(<button key={t.id} className="nb" onClick={function(){setTab(t.id);}}>{active&&<div style={{position:'absolute',top:0,left:'50%',transform:'translateX(-50%)',width:18,height:2,background:W,borderRadius:1}}/>}<div style={{opacity:active?1:0.28,transition:'opacity .2s'}}><t.Icon s={20} c={W}/></div><span style={{fontSize:10,fontWeight:active?700:400,color:active?W:W3,letterSpacing:'0.05em',textTransform:'uppercase',transition:'color .2s'}}>{t.l}</span></button>);})}</div>);
}

function Toast(props){if(!props.msg)return null;return <div className="toast">{props.msg}</div>;}

// ── MAIN ──────────────────────────────────────────────────
export default function NutriKenya(){
  var [screen,setScreen]=useState('auth'); // welcome screen shown immediately
  var [legalReturn,setLegalReturn]=useState('auth');
  var [tab,setTab]=useState('dashboard');
  var [lang,setLang]=useState('en');
  var [user,setUser]=useState(null);
  var [profile,setProfile]=useState(null);
  var [targets,setTargets]=useState(null);
  var [log,setLog]=useState({breakfast:[],lunch:[],dinner:[],snacks:[]});
  var [metrics,setMetrics]=useState([]);
  var [water,setWater]=useState(0);
  var [foods,setFoods]=useState([]);
  var [restaurants,setRestaurants]=useState([]);
  var [recentFoods,setRecentFoods]=useState([]);
  var [savedMeals,setSavedMeals]=useState([]);
  var [streak,setStreak]=useState(0);
  var [score,setScore]=useState(68);
  var [fasting,setFasting]=useState(false);
  var [fStart,setFStart]=useState(null);
  var [toast,setToast]=useState(null);
  var toastTimer=useRef(null);
  var authHandled=useRef(false);

  // No client-side router in this app — tabs are state, not routes — so
  // screen views need an explicit capture rather than posthog-js's
  // URL-change autocapture (which is disabled in analytics.js for exactly
  // this reason).
  useEffect(function(){
    if(screen==='app')track('screen_viewed',{screen:tab});
  },[screen,tab]);

  function showToast(msg){if(toastTimer.current)clearTimeout(toastTimer.current);setToast(msg);toastTimer.current=setTimeout(function(){setToast(null);},2200);}

  function pushRecent(food){
    setRecentFoods(function(list){
      var next=[{n:food.n,s:food.s||food.n,e:food.e||0,p:food.p||0,c:food.c||0,f:food.f||0,pr:food.pr||'',cat:'Recent'}].concat(list.filter(function(x){return x.n!==food.n;}));
      return next.slice(0,8);
    });
  }

  useEffect(function(){
    // Auth listener
    var sub=supabase.auth.onAuthStateChange(function(event,session){
      if(event==='PASSWORD_RECOVERY'){
        authHandled.current=true;
        setScreen('resetPassword');
        return;
      }
      if(event==='SIGNED_IN'&&session&&session.user&&!authHandled.current){
        // Only auto-skip welcome if user has a completed profile
        // No profile = new/incomplete user, let them tap through manually
        supabase.from('profiles').select('id').eq('id',session.user.id).single().then(function(r){
          if(r.data&&!authHandled.current){
            authHandled.current=true;
            handleAuthDone({name:session.user.email.split('@')[0],email:session.user.email,id:session.user.id});
          }
        });
        return;
      }
      if(event==='SIGNED_OUT'){authHandled.current=false;reset();}
    });

    // Check for existing session — only auto-navigate if profile exists
    supabase.auth.getSession().then(function(res){
      if(res.data.session&&res.data.session.user&&!authHandled.current){
        var u=res.data.session.user;
        supabase.from('profiles').select('id').eq('id',u.id).single().then(function(r){
          if(r.data&&!authHandled.current){
            authHandled.current=true;
            handleAuthDone({name:u.email.split('@')[0],email:u.email,id:u.id});
          }
          // No profile → stay on welcome screen
        });
      }
    });

    // Fetch food & restaurant data from Supabase
    Promise.all([
      supabase.from('foods').select('*').order('id'),
      supabase.from('restaurant_items').select('*, restaurants(name, group_name)').order('restaurant_id')
    ]).then(function(results){
      var f=results[0].data||[];
      var items=results[1].data||[];
      setFoods(f.map(function(x){
        return{id:x.id,n:x.name_en,s:x.name_sw,e:Number(x.calories),p:Number(x.protein),c:Number(x.carbs),f:Number(x.fat),pr:x.portion,cat:x.category};
      }));
      var map={};
      items.forEach(function(x){
        if(!x.restaurants)return;
        var rn=x.restaurants.name;
        if(!map[rn])map[rn]={name:rn,g:x.restaurants.group_name,items:[]};
        map[rn].items.push({n:x.name,e:x.calories,p:x.protein,c:x.carbs,f:x.fat,pr:'1 serving · est.'});
      });
      setRestaurants(Object.values(map));
    }).catch(function(e){console.error('Failed to load foods/restaurants:',e);});

    // Wire the offline queue: handlers are the actual network calls replayed
    // on flush (when connectivity returns), registered once since setLog is
    // a stable setState identity and safe to close over from a mount effect.
    registerHandler('food-log-insert',insertFoodLogRow);
    registerHandler('food-log-delete',function(payload){return supabase.from('food_logs').delete().eq('id',payload.id);});
    registerHandler('water-update',function(payload){return supabase.from('profiles').update({water_logged:payload.water_logged,water_date:payload.water_date}).eq('id',payload.userId);});
    registerHandler('body-metrics-insert',function(payload){return supabase.from('body_metrics').insert(payload);});
    registerHandler('profile-weight-update',function(payload){return supabase.from('profiles').update({weight:payload.weight}).eq('id',payload.userId);});
    installOnlineFlush();

    return function(){sub.data.subscription.unsubscribe();};
    // handleAuthDone only closes over stable state setters/refs and pure
    // helpers, so a fresh render's copy behaves identically — intentionally
    // omitted so this mount-only effect doesn't resubscribe every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  function insertFoodLogRow(payload){
    return supabase.from('food_logs').insert(payload.row).select('id').single().then(function(res){
      if(!res.error&&res.data&&res.data.id){
        setLog(function(l){
          var n=Object.assign({},l);
          Object.keys(n).forEach(function(m){n[m]=n[m].map(function(item){return item._k===payload._k?Object.assign({},item,{db_id:res.data.id}):item;});});
          return n;
        });
      }
      return res;
    });
  }

  async function addToLog(meal,food){
    var k=Date.now();
    var isFirstToday=['breakfast','lunch','dinner','snacks'].every(function(m){return log[m].length===0;});
    setLog(function(l){var n=Object.assign({},l);n[meal]=l[meal].concat([Object.assign({},food,{_k:k,db_id:null})]);return n;});
    pushRecent(food);
    var method={Restaurant:'restaurant','Quick Add':'quick_add',Barcode:'barcode','AI Scan':'ai_scan',Recent:'recent','Saved Meal':'saved_meal'}[food.cat]||'search';
    track('food_logged',{method:method,meal:meal});
    setScore(function(s){var ns=Math.min(s+2,100);if(user&&user.id){supabase.from('profiles').update({score:ns}).eq('id',user.id);}return ns;});
    if(isFirstToday){setStreak(function(s){return s+1;});}
    if(!user||!user.id)return;
    var payload={_k:k,row:{user_id:user.id,date:today(),meal:meal,food_name:food.n,food_name_sw:food.s||food.n,calories:food.e||0,protein:food.p||0,carbs:food.c||0,fat:food.f||0,portion:food.pr||''}};
    if(!navigator.onLine){queueWrite('food-log-insert',payload);showToast(food.n+" added — will sync when back online");return;}
    try{
      var res=await insertFoodLogRow(payload);
      if(res.error)throw res.error;
    }catch(e){
      console.error(e);logError('food-log-insert',e,user.id);
      queueWrite('food-log-insert',payload);
    }
  }

  async function saveMeal(name,items){
    if(!user||!user.id||items.length===0)return;
    var slim=items.map(function(i){return{n:i.n,s:i.s,e:i.e,p:i.p,c:i.c,f:i.f,pr:i.pr,cat:i.cat};});
    var res=await supabase.from('saved_meals').insert({user_id:user.id,name:name,items:slim}).select('*').single();
    if(res.error){console.error(res.error);logError('saved-meal-insert',res.error,user.id);showToast("Couldn't save meal — try again");return;}
    setSavedMeals(function(l){return[res.data].concat(l);});
    track('meal_saved',{item_count:slim.length});
    showToast('Meal saved');
  }

  async function deleteSavedMeal(id){
    setSavedMeals(function(l){return l.filter(function(m){return m.id!==id;});});
    var res=await supabase.from('saved_meals').delete().eq('id',id);
    if(res.error){console.error(res.error);logError('saved-meal-delete',res.error,user&&user.id);}
  }

  async function logSavedMeal(meal,savedMeal){
    track('saved_meal_logged',{item_count:savedMeal.items.length});
    for(var i=0;i<savedMeal.items.length;i++){
      await addToLog(meal,Object.assign({},savedMeal.items[i],{cat:'Saved Meal'}));
    }
  }

  async function handleAuthDone(userData){
    authHandled.current=true;
    setUser(userData);
    identifyUser(userData.id,{email:userData.email});
    if(userData.id){
      var pRes=await supabase.from('profiles').select('*').eq('id',userData.id).single();
      if(pRes.data){
        var d=pRes.data;
        // The DB row is snake_case; normalize to the camelCase shape the
        // freshly-onboarded profile object uses so fields like workoutType
        // and targetWeight aren't silently undefined after a re-login.
        setProfile(Object.assign({},d,{workoutType:d.workout_type,targetWeight:d.target_weight||0}));
        setTargets({calories:d.calories,protein:d.protein,carbs:d.carbs,fat:d.fat,water:d.water});
        setScore(typeof d.score==='number'?d.score:68);
        var lRes=await supabase.from('food_logs').select('*').eq('user_id',userData.id).eq('date',today());
        if(lRes.data&&lRes.data.length>0){var newLog={breakfast:[],lunch:[],dinner:[],snacks:[]};lRes.data.forEach(function(item){var m=item.meal;if(newLog[m]){newLog[m].push({n:item.food_name,s:item.food_name_sw||item.food_name,e:item.calories,p:item.protein,c:item.carbs,f:item.fat,pr:item.portion,cat:'Logged',_k:item.id,db_id:item.id});}});setLog(newLog);}
        var datesRes=await supabase.from('food_logs').select('date').eq('user_id',userData.id);
        if(datesRes.data){setStreak(calcStreak(new Set(datesRes.data.map(function(x){return x.date;}))));}
        var recentRes=await supabase.from('food_logs').select('food_name,food_name_sw,calories,protein,carbs,fat,portion').eq('user_id',userData.id).order('created_at',{ascending:false}).limit(40);
        if(recentRes.data){
          var seen={},uniq=[];
          recentRes.data.forEach(function(r){
            if(seen[r.food_name])return;seen[r.food_name]=true;
            uniq.push({n:r.food_name,s:r.food_name_sw||r.food_name,e:Number(r.calories)||0,p:Number(r.protein)||0,c:Number(r.carbs)||0,f:Number(r.fat)||0,pr:r.portion||'',cat:'Recent'});
          });
          setRecentFoods(uniq.slice(0,8));
        }
        var mRes=await supabase.from('body_metrics').select('*').eq('user_id',userData.id).order('created_at',{ascending:true});
        if(mRes.data&&mRes.data.length>0){setMetrics(mRes.data.map(function(m){return{date:new Date(m.date).toLocaleDateString('en-KE'),weight:m.weight,waist:m.waist,chest:m.chest,hips:m.hips,neck:m.neck};}));}
        var savedRes=await supabase.from('saved_meals').select('*').eq('user_id',userData.id).order('created_at',{ascending:false});
        if(savedRes.data){setSavedMeals(savedRes.data);}
        if(d.water_date===today()&&d.water_logged){setWater(d.water_logged);}
        setScreen('app');return;
      }
      if(pRes.error&&pRes.error.code!=='PGRST116'){
        // PGRST116 = no matching row, i.e. a genuinely new user who should
        // onboard. Anything else (network blip, RLS hiccup) is a transient
        // failure — routing to onboarding here would let handleOnboard's
        // upsert silently overwrite an existing user's real profile.
        authHandled.current=false;
        showToast("Couldn't load your profile. Check your connection and try again.");
        setScreen('auth');return;
      }
    }
    setScreen('onboard');
  }

  async function handleOnboard(pr){
    setProfile(pr);var t=calcTargets(pr);setTargets(t);
    if(user&&user.id){
      try{
        var res=await supabase.from('profiles').upsert({id:user.id,name:pr.name,age:pr.age,sex:pr.sex,weight:pr.weight,height:pr.height,goal:pr.goal,speed:pr.speed,activity:pr.activity,workout_type:pr.workoutType,restrictions:pr.restrictions,target_weight:pr.targetWeight||null,calories:t.calories,protein:t.protein,carbs:t.carbs,fat:t.fat,water:t.water,score:score});
        if(res.error)throw res.error;
      }catch(e){console.error(e);logError('onboard-save',e,user.id);showToast("Couldn't save your profile — check your connection");}
    }
    setScreen('app');
  }

  function reset(){
    supabase.auth.signOut();
    resetAnalytics();
    setUser(null);setProfile(null);setTargets(null);setScreen('auth');setTab('dashboard');
    setLog({breakfast:[],lunch:[],dinner:[],snacks:[]});setMetrics([]);setWater(0);setScore(68);setStreak(0);setFasting(false);setFStart(null);setRecentFoods([]);
    authHandled.current=false;
  }

  if(screen==='auth') return(<><GS/><Auth onDone={handleAuthDone} lang={lang} showToast={showToast} onLegal={function(doc){setLegalReturn('auth');setScreen(doc);}}/><Toast msg={toast}/></>);
  if(screen==='onboard') return(<><GS/><Onboard onDone={handleOnboard} uname={(user&&user.name)||''} lang={lang}/></>);
  if(screen==='resetPassword') return(<><GS/><ResetPassword onDone={function(){setScreen('auth');}} showToast={showToast}/><Toast msg={toast}/></>);
  if(screen==='privacy'||screen==='terms') return(<><GS/><LegalDoc doc={screen} onBack={function(){setScreen(legalReturn);}}/></>);

  return(
    <div style={{background:BG,position:'fixed',inset:0,fontFamily:FF,color:W}}>
      <GS/>
      <div className="scroll-inner" style={{paddingBottom:'calc(68px + env(safe-area-inset-bottom))'}}>
        {tab==='dashboard'&&<Dash profile={profile} targets={targets} log={log} water={water} setWater={setWater} score={score} lang={lang} streak={streak} fasting={fasting} setFasting={setFasting} fStart={fStart} setFStart={setFStart} showToast={showToast} userId={user&&user.id} foods={foods}/>}
        {tab==='log'&&<Log log={log} setLog={setLog} lang={lang} showToast={showToast} userId={user&&user.id} foods={foods} restaurants={restaurants} recentFoods={recentFoods} addToLog={addToLog} savedMeals={savedMeals} saveMeal={saveMeal} deleteSavedMeal={deleteSavedMeal} logSavedMeal={logSavedMeal}/>}
        {tab==='scan'&&<Scan addToLog={addToLog} lang={lang} showToast={showToast}/>}
        {tab==='metrics'&&<Metrics profile={profile} setProfile={setProfile} targets={targets} setTargets={setTargets} metrics={metrics} setMetrics={setMetrics} score={score} lang={lang} showToast={showToast} userId={user&&user.id}/>}
        {tab==='profile'&&<Profile profile={profile} targets={targets} lang={lang} setLang={setLang} score={score} streak={streak} setScore={setScore} onReset={reset} showToast={showToast} userEmail={user&&user.email} userId={user&&user.id} onLegal={function(doc){setLegalReturn('app');setScreen(doc);}}/>}
      </div>
      <Nav tab={tab} setTab={setTab} lang={lang}/>
      <Toast msg={toast}/>
    </div>
  );
}