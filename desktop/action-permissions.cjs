'use strict';
const fs=require('node:fs'),path=require('node:path');
class ActionPermissions {
  constructor(stateDir) {
    this.file=path.join(stateDir,'browser-action-permissions.json');
    this.settings={radar:false,assistant:false};
    try { const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));for(const key of Object.keys(this.settings))this.settings[key]=saved[key]===true; } catch {}
  }
  state(){return {...this.settings};}
  update(input) {
    if(!input || Object.keys(input).some(k=>!['radar','assistant'].includes(k)) || Object.values(input).some(v=>typeof v!=='boolean'))throw Error('Use boolean radar and assistant settings.');
    const next={...this.settings,...input};
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    fs.writeFileSync(this.file+'.tmp',JSON.stringify(next),{mode:0o600});
    fs.renameSync(this.file+'.tmp',this.file);this.settings=next;
    return this.state();
  }
  allows(clientId,action) {
    const enabled=clientId==='opportunity-radar-jobs'?this.settings.radar:clientId.startsWith('assistant:')?this.settings.assistant:false;
    return enabled && ['click','fill','press','upload','api_call'].includes(action.action);
  }
}
module.exports={ActionPermissions};
