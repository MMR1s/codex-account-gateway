/* Spatial account network. Geometry is ambient; counters and task edges use real records. */
(() => {
  'use strict';
  const canvas=document.getElementById('network-canvas'),ctx=canvas.getContext('2d');
  const stage=document.getElementById('scene-stage'),labels=document.getElementById('network-labels'),dock=document.getElementById('account-stations');
  const palette=['#b5a1ff','#62d5e9','#f2b86a','#f58cb9','#78d6b2','#8aabff'];
  const safe=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const camera={yaw:-.08,pitch:.55,zoom:1,paused:matchMedia('(prefers-reduced-motion: reduce)').matches};
  let status=null,selected='a',mode='pool',nodes=[],accountNodes=[],agentNodes=[],agentSnapshot=null,selectedAgent=null;
  let ring=[],threadsVisible=true,w=1,h=1,clock=0,last=0,drag=null,hovered=null,labelKey='',dockKey='',geometryKey='';
  let syaw=0,cyaw=1,spitch=0,cpitch=1,scale=1;
  let liveAgents=new Map(),delegatingAgents=new Set();
  function syncAgentActivity(){
    liveAgents=new Map();delegatingAgents=new Set();
    for(const request of status?.activity.inflight||[]){
      if(!request.thread_id)continue;
      if(!liveAgents.has(request.thread_id))liveAgents.set(request.thread_id,[]);
      liveAgents.get(request.thread_id).push(request);
    }
    const byId=new Map(agentNodes.map(node=>[node.id,node]));
    for(const id of liveAgents.keys()){
      let node=byId.get(id),visited=new Set();
      while(node?.parentId&&!visited.has(node.parentId)){
        visited.add(node.parentId);delegatingAgents.add(node.parentId);node=byId.get(node.parentId);
      }
    }
    for(const node of agentNodes){
      node.liveRequests=liveAgents.get(node.id)||[];
      node.liveState=node.liveRequests.length?'responding':delegatingAgents.has(node.id)?'delegating':'unobserved';
      node.liveAccounts=[...new Set(node.liveRequests.map(request=>request.slot))];
    }
  }
  function random(seed){return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
  function cloud(seed,count,sx,sy,sz){const r=random(seed);return Array.from({length:count},()=>[(r()-.5)*sx,(r()-.5)*sy,(r()-.5)*sz,r()]);}
  function stationArt(slot,connected=true){
    const letter=safe(slot.toUpperCase()),index=slot.charCodeAt(0)-97,height=44+index%3*10;
    return '<svg class="station-art" viewBox="0 0 260 135" aria-hidden="true"><defs><pattern id="hatch-'+slot+'" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 5L5 0" stroke="currentColor" stroke-width=".3" opacity=".18"/></pattern><linearGradient id="face-'+slot+'" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#242424"/><stop offset="1" stop-color="#090909"/></linearGradient></defs><path class="art-ground" d="M17 110L119 56L244 105L141 157M35 95L160 144M70 77L197 127M103 60L229 111" fill="none" stroke="currentColor" opacity=".09"/><path d="M58 93L119 68L203 97L142 123Z" fill="#111" stroke="currentColor" opacity=".35"/><path d="M79 '+(94-height)+'L125 '+(74-height)+'L184 '+(96-height)+'L139 '+(116-height)+'Z" fill="#242424" stroke="currentColor" stroke-width=".8"/><path d="M79 '+(94-height)+'L139 '+(116-height)+'V112L79 91Z" fill="url(#face-'+slot+')" stroke="currentColor" stroke-width=".65"/><path d="M139 '+(116-height)+'L184 '+(96-height)+'V93L139 112Z" fill="url(#hatch-'+slot+')" stroke="currentColor" stroke-width=".65"/>'+Array.from({length:5},(_,i)=>'<path d="M86 '+(102-height+i*7)+'L131 '+(119-height+i*7)+'" stroke="currentColor" stroke-width=".65" opacity="'+(connected?.45:.18)+'"/>').join('')+'<text x="155" y="'+(height>50?69:78)+'" fill="currentColor" font-family="Arial,sans-serif" font-size="20" font-weight="700">'+letter+'</text><path d="M58 93V100L142 131L203 105V97M142 123V131M119 68V74" fill="none" stroke="currentColor" stroke-width=".7" opacity=".35"/><path class="art-accent" d="M79 '+(94-height)+'L125 '+(74-height)+'L184 '+(96-height)+'" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="70" cy="104" r="2" fill="currentColor" opacity="'+(connected?.8:.2)+'"/></svg>';
  }

  function fit(){
    const rect=canvas.getBoundingClientRect();if(rect.width<1||rect.height<1)return false;
    w=rect.width;h=rect.height;const ratio=Math.min(devicePixelRatio||1,1.6);
    if(canvas.width!==Math.round(w*ratio)||canvas.height!==Math.round(h*ratio)){canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}
    ctx.setTransform(ratio,0,0,ratio,0,0);
    const yaw=camera.yaw+(camera.paused||drag?0:Math.sin(clock*.00009)*.026);
    syaw=Math.sin(yaw);cyaw=Math.cos(yaw);spitch=Math.sin(camera.pitch);cpitch=Math.cos(camera.pitch);
    scale=Math.min(w/(mode==='agents'?980:930),h/590)*camera.zoom;
    return true;
  }
  function project(x,y,z){
    const xx=x*cyaw-z*syaw,zz=x*syaw+z*cyaw;
    return {x:w/2+xx*scale,y:h*.49-(y*cpitch-zz*spitch)*scale,depth:y*spitch+zz*cpitch};
  }
  function path(points,color,alpha=.3,lineWidth=.7,dashed=false){
    ctx.strokeStyle=color;ctx.globalAlpha=alpha;ctx.lineWidth=lineWidth;ctx.setLineDash(dashed?[3,5]:[]);
    ctx.beginPath();points.forEach((v,i)=>{const p=project(...v);if(i)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);});ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
  }
  const edges=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  function wireBox(node,alpha=.5,expand=1){
    const {x,y,z,sx=85,sy=65,sz=65}=node;
    const vertices=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(p=>project(x+p[0]*sx*.5*expand,y+p[1]*sy*.5*expand,z+p[2]*sz*.5*expand));
    ctx.strokeStyle=node.color;ctx.globalAlpha=alpha;ctx.lineWidth=.7;ctx.setLineDash(node.connected===false?[3,5]:[]);
    ctx.beginPath();for(const [a,b] of edges){ctx.moveTo(vertices[a].x,vertices[a].y);ctx.lineTo(vertices[b].x,vertices[b].y);}ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
  }
  function drawCloud(points,pos,color,alpha=1){
    ctx.fillStyle=color;
    for(const point of points){const drift=camera.paused?0:Math.sin(clock*.0004+point[3]*8)*1.7,p=project(pos.x+point[0],pos.y+point[1]+drift,pos.z+point[2]);
      const size=Math.max(.6,(point[3]>.94?1.7:.85)*Math.min(1.35,scale));
      ctx.globalAlpha=(.18+point[3]*.72)*alpha;ctx.fillRect(p.x,p.y,size,size);
    }ctx.globalAlpha=1;
  }
  function glow(pos,color,radius,alpha=.15){
    const p=project(pos.x,pos.y,pos.z),r=Math.max(18,radius*scale),g=ctx.createRadialGradient(p.x,p.y,1,p.x,p.y,r);
    g.addColorStop(0,color);g.addColorStop(1,color+'00');ctx.globalAlpha=alpha;ctx.fillStyle=g;ctx.fillRect(p.x-r,p.y-r,r*2,r*2);ctx.globalAlpha=1;
  }
  function buildAmbient(slots){
    const rand=random(43012);
    ring=Array.from({length:3800},()=>{const angle=rand()*Math.PI*2,radius=224+(rand()-.5)*19,y=-48+(rand()-.5)*14;return {x:Math.cos(angle)*radius,y,z:Math.sin(angle)*radius,b:rand(),sector:Math.floor(angle/Math.PI/2*slots.length)%slots.length};});
  }
  function rebuildAccounts(){
    const slots=Object.keys(status.accounts),key=slots.join(',')+'|'+slots.map(slot=>status.accounts[slot].connected).join(',');
    if(key===geometryKey)return;geometryKey=key;buildAmbient(slots);
    const preset=slots.length===3?[[309,20,89],[-306,32,50],[10,30,-277]]:slots.length===2?[[305,30,55],[-305,30,55]]:null;
    accountNodes=slots.map((slot,i)=>{const angle=i/slots.length*Math.PI*2+.28,radius=slots.length>8?340:310,presetPos=preset?.[i],a=status.accounts[slot],position=presetPos||[Math.cos(angle)*radius,24+Math.sin(i*2)*16,Math.sin(angle)*radius];
      return {id:slot,slot,index:i,x:position[0],y:position[1],z:position[2],sx:91,sy:63,sz:72,color:palette[i%palette.length],connected:a.connected,cloud:cloud(slot.charCodeAt(0)*543,Math.max(140,Math.min(680,3200/slots.length)),78,49,61),stationCloud:cloud(slot.charCodeAt(0)*763,Math.max(100,Math.min(1300,4200/slots.length)),115,93,82)};
    });
    labelKey='';dockKey='';
  }
  function accountPosition(node){
    if(mode!=='station')return node;
    const slotIndex=node.index,count=accountNodes.length;
    if(count===3){const p=[[251,55,32],[-253,55,40],[4,67,-262]][slotIndex];return {...node,x:p[0],y:p[1],z:p[2],sx:122,sy:99,sz:88};}
    return {...node,y:65,sx:105,sy:90,sz:82};
  }
  function selectedNode(node){return node.kind==='agent'||node.kind==='subagent'?node.id===selectedAgent:node.slot===selected;}
  function rootPosition(){return mode==='station'?{x:0,y:-78,z:218}:{x:0,y:-37,z:0};}
  function drawBackdrop(){
    ctx.fillStyle='#050608';ctx.fillRect(0,0,w,h);
    const haze=ctx.createRadialGradient(w*.5,h*.47,5,w*.5,h*.47,w*.55);haze.addColorStop(0,'#3b24460d');haze.addColorStop(1,'#05060800');ctx.fillStyle=haze;ctx.fillRect(0,0,w,h);
    if(mode==='station'){for(let i=-6;i<=6;i++){path([[i*65,-112,-390],[i*65,-112,400]],'#9699a8',.055,.55);path([[-420,-112,i*65],[420,-112,i*65]],'#9699a8',.055,.55);}}
    else{
      const sizes=[174,238,363,420];for(const radius of sizes){const pts=[];for(let i=0;i<=100;i++){const a=i/100*Math.PI*2;pts.push([Math.cos(a)*radius,-52,Math.sin(a)*radius]);}path(pts,'#bac2d3',radius===238?.20:.075,.6);}
      for(let i=0;i<48;i++){const a=i/48*Math.PI*2;path([[Math.cos(a)*400,-52,Math.sin(a)*400],[Math.cos(a)*407,-52,Math.sin(a)*407]],'#a6afc2',.21,.6);}
    }
  }
  function drawOrbit(drawTasks=true){
    if(!status)return;
    for(const p of ring){const node=accountNodes[p.sector%accountNodes.length],point=project(p.x,p.y+(camera.paused?0:Math.sin(clock*.0003+p.b*12)*.7),p.z);
      ctx.fillStyle=p.b>.72?(node?.color||'#fff'):'#d7dce7';ctx.globalAlpha=(.28+p.b*.7)*(node?.connected?1:.48)*(camera.paused?1:.88+Math.sin(clock*.0003+p.b*8)*.12);ctx.fillRect(point.x,point.y,p.b>.92?1.6:.85,p.b>.92?1.6:.85);}
    ctx.globalAlpha=1;
    for(let i=0;i<15;i++){const points=[];for(let k=0;k<=60;k++){const a=k/60*Math.PI*2,r=216+Math.sin(a*3+i*.71)*26,yy=-27+Math.cos(a*2+i*.4+clock*.00008)*19;points.push([Math.cos(a)*r,yy,Math.sin(a)*r]);}path(points,'#a8b2c9',.075,.5);}
    if(drawTasks&&threadsVisible)drawAgents();
  }
  function drawAccountLink(node){
    const root=rootPosition(),point=accountPosition(node),middle=[point.x*.48,-58,point.z*.48],line=[[root.x,root.y,root.z],middle,[point.x,point.y-point.sy*.5,point.z]];
    const busy=(status.activity.inflight||[]).some(r=>r.slot===node.slot);
    path(line,node.color,node.connected?(busy?.95:.35):.16,busy?1.4:.8,!node.connected);
    if(busy&&!camera.paused){const t=(clock*.00043+node.index*.2)%1,segment=t<.5?0:1,u=t<.5?t*2:(t-.5)*2,p3=line[segment].map((v,k)=>v+(line[segment+1][k]-v)*u),p=project(...p3);
      ctx.fillStyle='#fff';ctx.shadowColor=node.color;ctx.shadowBlur=12;ctx.beginPath();ctx.arc(p.x,p.y,2.8,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;}
  }
  function drawAccount(node){
    const p=accountPosition(node),isSelected=selectedNode(node),a=node.connected?1:.34;
    glow(p,node.color,108,isSelected?.15:.075);
    if(mode==='station'){
      wireBox(p,isSelected?.8:.45);wireBox({...p,y:p.y-p.sy*.65,sx:p.sx*1.25,sy:10,sz:p.sz*1.25},.35);
      drawCloud(node.stationCloud,p,node.color,a);
      path([[p.x-p.sx*.5,p.y+p.sy*.5,p.z-p.sz*.5],[p.x+p.sx*.5,p.y+p.sy*.5,p.z-p.sz*.5],[p.x+p.sx*.5,p.y+p.sy*.5,p.z+p.sz*.5]],node.color,.85,1.4);
    }else{
      wireBox({...p,y:p.y-25,sy:15,sx:110,sz:90},isSelected?.75:.38);
      wireBox({...p,y:p.y+8,sy:57,sx:74,sz:62},isSelected?.7:.38);
      drawCloud(node.cloud,{...p,y:p.y+7},node.color,a);
      path([[p.x-50,p.y-38,p.z-42],[p.x+50,p.y-38,p.z-42],[p.x+50,p.y-38,p.z+42],[p.x-50,p.y-38,p.z+42],[p.x-50,p.y-38,p.z-42]],node.color,.55,.8);
    }
    const letter=project(p.x,p.y+14,p.z+45);ctx.fillStyle=node.connected?'#f1f3fb':'#a99c89';ctx.globalAlpha=node.connected?.9:.65;ctx.font='600 '+Math.max(13,23*scale)+'px Consolas';ctx.textAlign='center';ctx.fillText(node.slot.toUpperCase(),letter.x,letter.y);ctx.globalAlpha=1;
    if(isSelected)wireBox({...p,sx:p.sx*1.18,sy:p.sy*1.2,sz:p.sz*1.18},.26);
  }
  function drawGateway(){
    const root=rootPosition();glow(root,'#d8d8ed',65,.12);
    wireBox({...root,sx:99,sy:19,sz:70,color:'#cbd1dd'},.3);
    wireBox({...root,y:root.y-9,sx:118,sy:12,sz:85,color:'#8d93a7'},.18);
  }
  function buildAgentNodes(snapshot){
    agentSnapshot=snapshot;agentNodes=[];
    if(snapshot?.state!=='available'){if(mode==='agents')nodes=[];labelKey='';document.getElementById('scene-agent-count').textContent=snapshot?'Task records unavailable':'Loading task threads…';return;}
    const roots=snapshot.tasks||[],count=roots.length;
    function add(record,parent,rootIndex,angle,radius,depth){
      const seed=record.id.split('').reduce((s,c)=>Math.imul(s,31)+c.charCodeAt(0),8513),rand=random(seed),y=depth===0?42+rand()*82:parent.y+18+rand()*30;
      const position={x:Math.cos(angle)*radius,y,z:Math.sin(angle)*radius},color=parent?.color||palette[(seed>>>0)%palette.length];
      const branchAt=.59+rand()*.2,from=parent?parent.stemFrom.map((v,k)=>v+(parent.stemTo[k]-v)*branchAt):[Math.cos(angle)*224,-44,Math.sin(angle)*224],to=[position.x,position.y,position.z];
      const node={...record,...position,id:record.id,parentId:parent?.id,rootIndex,angle,radius,depth,index:agentNodes.length,color,stemFrom:from,stemTo:to,
        cloud:cloud(seed,count>10?(depth?31:70):(depth?95:220),depth?17:24,depth?22:30,depth?17:24)};
      node.trail=Array.from({length:depth?36:95},()=>{const t=rand(),jitter=depth?2:3;return from.map((v,k)=>v+(to[k]-v)*t+(rand()-.5)*jitter).concat(rand());});
      agentNodes.push(node);
      const children=record.children||[],spread=Math.min(.28,Math.PI*1.8/Math.max(5,count));
      children.forEach((child,i)=>add(child,node,rootIndex,angle+(i-(children.length-1)/2)*spread/Math.max(1,children.length-1),radius+28+depth*7,depth+1));
    }
    roots.forEach((record,i)=>add(record,null,i,count===1?-.9:i/count*Math.PI*2-.35,306+(i%4)*12,0));
    if(selectedAgent&&!agentNodes.some(n=>n.id===selectedAgent))selectedAgent=null;
    if(mode==='agents'&&!selectedAgent)selectedAgent=agentNodes[0]?.id||null;
    if(mode==='agents')nodes=agentNodes;labelKey='';
    syncAgentActivity();
    const subs=agentNodes.filter(n=>n.depth>0).length;
    document.getElementById('scene-agent-count').textContent=(snapshot.truncated?roots.length+' of '+snapshot.task_count:roots.length)+' main agent'+(snapshot.task_count===1?'':'s')+' / '+subs+' subagent'+(subs===1?'':'s');
  }
  function drawAgents(){
    if(!agentSnapshot||agentSnapshot.state!=='available')return;
    const byId=new Map(agentNodes.map(n=>[n.id,n])),highlighted=new Set();let focus=byId.get(selectedAgent||hovered);
    while(focus){highlighted.add(focus.id);focus=byId.get(focus.parentId);}
    const selectedFamily=byId.get(selectedAgent||hovered)?.rootIndex;
    for(const node of agentNodes){
      const responding=node.liveState==='responding',delegating=node.liveState==='delegating',lit=responding||delegating;
      const pulse=camera.paused?1:.73+Math.sin(clock*.004+node.index)*.27;
      const onPath=highlighted.has(node.id),family=selectedFamily===node.rootIndex,alpha=lit?1:onPath?.98:family?.65:selectedFamily!=null?.17:node.depth?.38:.48;
      if(lit){glow(node,node.color,responding?74:50,(responding?.29:.16)*pulse);path([node.stemFrom,node.stemTo],node.color,.17,responding?7:4);}
      path([node.stemFrom,node.stemTo],node.color,alpha,responding?2.5:delegating?1.6:onPath?1.6:node.depth?.7:.85);
      drawCloud(node.trail,{x:0,y:0,z:0},node.color,lit?1:onPath?.92:family?.7:selectedFamily!=null?.16:.58);
      drawCloud(node.cloud,node,node.color,lit?1:onPath?1:family?.95:selectedFamily!=null?.35:.78);
      if(responding){
        const t=camera.paused?.7:(clock*.00065+node.index*.11)%1,p=project(...node.stemFrom.map((value,k)=>value+(node.stemTo[k]-value)*t));
        ctx.fillStyle='#fff';ctx.shadowColor=node.color;ctx.shadowBlur=14;ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
      }
      const p=project(node.x,node.y,node.z);ctx.strokeStyle=node.color;ctx.fillStyle=responding?'#fff':onPath?'#f2eefb':node.depth?'#d2e5ee':node.color;ctx.globalAlpha=lit||onPath?1:.85;
      if(node.depth){ctx.fillRect(p.x-1.6,p.y-1.6,3.2,3.2);}else{ctx.beginPath();ctx.moveTo(p.x,p.y-4);ctx.lineTo(p.x+4,p.y);ctx.lineTo(p.x,p.y+4);ctx.lineTo(p.x-4,p.y);ctx.closePath();ctx.stroke();}
      if(onPath){ctx.beginPath();ctx.arc(p.x,p.y,9,0,Math.PI*2);ctx.lineWidth=.8;ctx.stroke();glow(node,node.color,38,.14);}
      if(lit){ctx.beginPath();ctx.arc(p.x,p.y,(responding?13:11)+(camera.paused?0:4*pulse),0,Math.PI*2);ctx.lineWidth=responding?1.6:1;ctx.globalAlpha=pulse;ctx.setLineDash(delegating?[2,4]:[]);ctx.stroke();ctx.setLineDash([]);if(responding){ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(p.x,p.y,3.2,0,Math.PI*2);ctx.fill();}}
      ctx.globalAlpha=1;
    }
  }
  function labelNodes(){
    if(mode==='agents')return agentNodes.filter(n=>n.id===selectedAgent||n.id===hovered||n.liveState==='responding'||n.liveState==='delegating');
    let shown=nodes.length<=8?[...nodes]:nodes.filter(n=>n.slot===selected||n.slot===status.active||n.id===hovered||n.index<3);
    if(mode==='pool'&&threadsVisible)shown.push(...agentNodes.filter(n=>n.id===selectedAgent||n.id===hovered||n.liveState==='responding'||n.liveState==='delegating'||(!selectedAgent&&!hovered&&w>650&&n.index===0)));
    return shown;
  }
  function renderLabels(){
    const shown=labelNodes(),signature=mode+'|'+selectedAgent+'|'+shown.map(n=>n.id+':'+selectedNode(n)+':'+n.connected).join('|')+'|'+(status?status.active:'')+'|'+JSON.stringify(status?.activity.inflight||[])+'|'+(mode==='agents'?'':JSON.stringify(Object.values(status?.accounts||{}).map(a=>[a.quota.windows?.[0]?.remaining_percent,!!a.cooldown_seconds])));
    if(signature!==labelKey){
      labelKey=signature;labels.replaceChildren();
      for(const node of shown){const button=document.createElement('button');button.className='spatial-node-label'+((node.kind==='agent'||node.kind==='subagent'?node.id===selectedAgent:selectedNode(node))?' selected':'')+(node.connected===false?' disconnected':'');button.dataset.id=node.id;button.style.setProperty('--node-color',node.color);button.setAttribute('aria-pressed',String(selectedNode(node)));
        if(node.kind==='agent'||node.kind==='subagent'){
          const responding=node.liveState==='responding',delegating=node.liveState==='delegating',state=responding?'RESPONDING':delegating?'SUBAGENT ACTIVE':'RECORDED';
          button.classList.toggle('agent-responding',responding);button.classList.toggle('agent-delegating',delegating);
          button.setAttribute('aria-label','Inspect '+(node.depth?'subagent ':'agent ')+(node.nickname||node.title)+' · '+state.toLowerCase());
          button.innerHTML='<span class="node-tag">'+(node.depth?'↳':'⌘')+'</span><span class="node-label-copy"><strong>'+safe((node.nickname||node.title||'Untitled task').slice(0,w<600?23:36))+'</strong><small>'+(responding||delegating?'<i class="agent-activity-dot"></i>':'')+(node.depth?'SUBAGENT':'MAIN AGENT')+' / '+state+'</small></span>';button.addEventListener('click',()=>window.chooseSceneAgent(node.id));
        }
        else {const a=status.accounts[node.slot],busy=(status.activity.inflight||[]).some(r=>r.slot===node.slot),state=busy?'Processing':a.cooldown_seconds?'Cooldown':a.connected?(status.active===node.slot?'Routing':'Ready'):'Not connected',q=a.quota.windows?.[0];button.setAttribute('aria-label','Inspect Account '+node.slot.toUpperCase());button.innerHTML='<span class="node-tag">'+node.slot.toUpperCase()+'</span><span class="node-label-copy"><strong>Account '+node.slot.toUpperCase()+'</strong><small><i class="node-status-dot"></i>'+state+(a.connected&&q?' · '+safe(q.remaining_percent)+'% left':'')+'</small></span>';button.addEventListener('click',()=>window.chooseDesk(node.slot));}
        labels.append(button);
      }
      const hub=document.createElement('div');hub.className='spatial-hub';hub.dataset.id='hub';hub.innerHTML=mode==='agents'?'<span>LOCAL CODEX / TASK MAP</span><strong>Agent constellation</strong><small>Recorded parent / child relationships</small>':'<span>ONE SHARED WORKSPACE</span><strong>Relay gateway<span> ↗</span></strong><small>LOCAL / 127.0.0.1:4000</small>';labels.append(hub);
    }
    const placed=[],hub=project(...Object.values(rootPosition()));
    for(const element of labels.children){const node=element.dataset.id==='hub'?rootPosition():[...nodes,...agentNodes].find(n=>n.id===element.dataset.id);if(!node)continue;
      const isTask=node.kind==='agent'||node.kind==='subagent',position=isTask||element.dataset.id==='hub'?node:accountPosition(node),p=project(position.x,position.y,position.z);
      if(element.dataset.id==='hub'){element.style.left=p.x+'px';element.style.top=(p.y-20)+'px';continue;}
      const ew=element.offsetWidth||158,eh=element.offsetHeight||62;let x=Math.max(ew/2+10,Math.min(w-ew/2-10,p.x)),y=p.y+(isTask?19:mode==='station'?78:63)*scale;
      y=Math.max(91,Math.min(h-96-eh,y));
      const hubRect={x:hub.x-100,y:hub.y-43,width:200,height:88};
      for(let j=0;j<12;j++){const overlaps=placed.some(b=>Math.abs(b.x-x)<(b.width+ew)/2+5&&Math.abs(b.y-y)<(b.height+eh)/2+8);const core=x+ew/2>hubRect.x&&x-ew/2<hubRect.x+hubRect.width&&y<hubRect.y+hubRect.height&&y+eh>hubRect.y;if(!overlaps&&!core)break;y=y<hub.y?y-16:y+16;y=Math.max(85,Math.min(h-96-eh,y));}
      element.style.left=x+'px';element.style.top=y+'px';placed.push({x,y:y+eh/2,width:ew,height:eh});
    }
  }
  function renderDock(){
    if(!status)return;
    const slots=Object.keys(status.accounts),key=slots.map(s=>s+':'+status.accounts[s].connected+':'+(s===selected)+':'+(s===status.active)).join('|');
    if(key===dockKey)return;dockKey=key;
    dock.innerHTML=slots.map((slot,i)=>{const a=status.accounts[slot];return '<button class="dock-account '+(slot===selected?'selected':'')+(!a.connected?' disconnected':'')+'" style="--node-color:'+palette[i%palette.length]+'" data-slot="'+slot+'" aria-label="Inspect Account '+slot.toUpperCase()+'" aria-pressed="'+(slot===selected)+'"><span>'+slot.toUpperCase()+'</span><strong>Account '+slot.toUpperCase()+'</strong><small>'+(a.connected?(slot===status.active?'Routing':'Connected'):'Disconnected')+'</small></button>';}).join('');
    dock.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>window.chooseDesk(b.dataset.slot)));
  }
  function update(data,selectedSlot){
    status=data;selected=selectedSlot;rebuildAccounts();nodes=mode==='agents'?agentNodes:accountNodes;syncAgentActivity();
    const live=agentNodes.filter(node=>node.liveState==='responding'),main=live.filter(node=>!node.depth).length,subs=live.length-main;
    renderDock();document.getElementById('scene-traffic').textContent=mode==='agents'?(live.length?main+' agents · '+subs+' subagents responding':'No live gateway requests'):(data.activity.inflight||[]).length+' requests in flight';
    document.querySelector('.scene-readout').classList.toggle('has-live-activity',!!(data.activity.inflight||[]).length);
    document.getElementById('scene-stage').classList.toggle('motion-paused',camera.paused);
  }
  function setMode(value){
    mode=value;nodes=mode==='agents'?agentNodes:accountNodes;labelKey='';
    document.getElementById('scene-label').textContent=mode==='agents'?'AGENT CONSTELLATION':mode==='station'?'ACCOUNT STATION':'ACCOUNT ORBIT';
    document.getElementById('scene-description').textContent=mode==='agents'?'Hover a thread · inspect its delegated work':mode==='station'?'Separate accounts · one local workspace':'Account platforms + recorded task threads';
    if(mode==='agents'&&!selectedAgent)selectedAgent=agentNodes[0]?.id||null;
    document.getElementById('scene-mode').textContent=mode==='agents'?'TASKS / RECORDED HIERARCHY':mode==='station'?'STATION / ISOMETRIC':'ORBIT / ACCOUNT WORKERS';
    if(status)update(status,selected);
  }
  function frame(now){
    requestAnimationFrame(frame);if(now-last<34||document.hidden||stage.offsetParent===null)return;
    const elapsed=Math.min(100,now-last||34);last=now;if(!camera.paused&&!drag)clock+=elapsed;
    if(!fit())return;drawBackdrop();
    if(mode==='agents'){drawOrbit(false);drawAgents();}else {if(mode==='pool')drawOrbit();for(const node of nodes)drawAccountLink(node);[...nodes].sort((a,b)=>project(a.x,a.y,a.z).depth-project(b.x,b.y,b.z).depth).forEach(drawAccount);drawGateway();}
    renderLabels();
  }
  function pick(x,y){
    let hit=null,best=Infinity;
    if(mode!=='agents'){for(const node of accountNodes){const q=accountPosition(node),point=project(q.x,q.y,q.z),distance=Math.hypot(point.x-x,point.y-y);if(distance<Math.max(15,35*scale)&&distance<best){hit=node;best=distance;}}if(hit)return hit;}
    if(mode==='station'||(mode==='pool'&&!threadsVisible))return null;
    for(const node of agentNodes){const a=project(...node.stemFrom),b=project(...node.stemTo),dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/den)):0;
      const distance=Math.min(Math.hypot(x-(a.x+t*dx),y-(a.y+t*dy)),Math.hypot(b.x-x,b.y-y));
      if(distance<(node.depth?6:8)&&distance<best){hit=node;best=distance;}
    }return hit;
  }
  canvas.addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY,yaw:camera.yaw,pitch:camera.pitch,moved:false};canvas.setPointerCapture(event.pointerId);});
  canvas.addEventListener('pointermove',event=>{if(drag){const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag.moved=drag.moved||Math.abs(dx)+Math.abs(dy)>5;camera.yaw=drag.yaw+dx*.0045;camera.pitch=Math.max(.15,Math.min(1.1,drag.pitch+dy*.004));}
    else{const r=canvas.getBoundingClientRect(),hit=pick(event.clientX-r.left,event.clientY-r.top);hovered=hit?.id||null;canvas.style.cursor=hit?'pointer':'grab';}});
  canvas.addEventListener('pointerup',event=>{if(drag&&!drag.moved){const r=canvas.getBoundingClientRect(),hit=pick(event.clientX-r.left,event.clientY-r.top);if(hit){if(hit.kind==='agent'||hit.kind==='subagent')window.chooseSceneAgent(hit.id);else window.chooseDesk(hit.slot);}}drag=null;});
  canvas.addEventListener('pointercancel',()=>drag=null);
  canvas.addEventListener('pointerleave',event=>{if(event.relatedTarget?.closest?.('.spatial-node-label')?.dataset.id!==hovered)hovered=null;});
  stage.addEventListener('pointerleave',()=>hovered=null);
  canvas.addEventListener('wheel',event=>{event.preventDefault();camera.zoom=Math.max(.6,Math.min(1.65,camera.zoom-event.deltaY*.0008));},{passive:false});
  canvas.addEventListener('keydown',event=>{if(event.key==='ArrowLeft')camera.yaw-=.1;else if(event.key==='ArrowRight')camera.yaw+=.1;else if(event.key==='ArrowUp')camera.pitch=Math.min(1.1,camera.pitch+.07);else if(event.key==='ArrowDown')camera.pitch=Math.max(.15,camera.pitch-.07);else if(event.key==='+'||event.key==='=')camera.zoom=Math.min(1.65,camera.zoom+.1);else if(event.key==='-')camera.zoom=Math.max(.6,camera.zoom-.1);else return;event.preventDefault();});
  window.RelayScene={update,stationArt,setMode,setAgents:buildAgentNodes,
    toggleThreads(){threadsVisible=!threadsVisible;labelKey='';return threadsVisible;},selectAgent(id){selectedAgent=id;hovered=null;labelKey='';},showThreads(){threadsVisible=true;labelKey='';},getSelectedAgent(){return agentNodes.find(n=>n.id===selectedAgent)||null;},getAgent(id){return agentNodes.find(n=>n.id===id)||null;},
    pause(){camera.paused=!camera.paused;stage.classList.toggle('motion-paused',camera.paused);return camera.paused;},
    reset(){camera.yaw=-.08;camera.pitch=.55;camera.zoom=1;labelKey='';},resize(){labelKey='';},
    summary(){return {mode,accounts:accountNodes.length,agents:agentNodes.length,threadsVisible,selectedAgent,paused:camera.paused,responding:agentNodes.filter(n=>n.liveState==='responding').map(n=>n.id),delegating:agentNodes.filter(n=>n.liveState==='delegating').map(n=>n.id)};}
  };
  requestAnimationFrame(frame);
})();
