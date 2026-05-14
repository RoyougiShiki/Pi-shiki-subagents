// Standalone Node script: send message to chair.
// Usage: node persistent-send.js <chairName> <messageText>
// Env: PI_AGENT_NAME, COLLABORATING_AGENTS_DIR
const B=process.env.COLLABORATING_AGENTS_DIR||require("path").join(require("os").homedir(),".pi/agent/collaborating-agents");
const L=B+"/messages.jsonl";
const S=process.env.PI_AGENT_NAME;
const to=process.argv[2]||"";
const tx=process.argv.slice(3).join(" ");
if(!to||!tx.trim()){console.log("SKIP");process.exit(0)}
const TS=new Date().toISOString();
require("fs").mkdirSync(B+"/inbox/"+to,{recursive:true});
const fn=Date.now()+"-"+process.pid;require("fs").writeFileSync(B+"/inbox/"+to+"/"+fn+".tmp",JSON.stringify({id:require("crypto").randomUUID(),from:S,to,text:tx,kind:"direct",timestamp:TS}));require("fs").renameSync(B+"/inbox/"+to+"/"+fn+".tmp",B+"/inbox/"+to+"/"+fn+".json");
require("fs").appendFileSync(L,JSON.stringify({id:require("crypto").randomUUID(),from:S,to,text:tx,kind:"direct",timestamp:TS})+"\\n");
console.log("OK");
