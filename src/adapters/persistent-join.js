// Standalone Node script: send READY signal to chair.
// Usage: node persistent-join.js <chairName> <meetingId> <agentType>
// Env: PI_AGENT_NAME, COLLABORATING_AGENTS_DIR
const B=process.env.COLLABORATING_AGENTS_DIR||require("path").join(require("os").homedir(),".pi/agent/collaborating-agents");
const L=B+"/messages.jsonl";
const S=process.env.PI_AGENT_NAME||"unknown";
const to=process.argv[2];
const mid=process.argv[3];
const role=process.argv[4];
if(!to||!mid){process.exit(1)}
const ts=new Date().toISOString();
const t="[meeting:"+mid+"][round:0][phase:join][role:"+role+"]\\n{\\\"status\\\":\\\"ready\\\"}";
require("fs").mkdirSync(B+"/inbox/"+to,{recursive:true});
const fn=Date.now()+"-"+process.pid;require("fs").writeFileSync(B+"/inbox/"+to+"/"+fn+".tmp",JSON.stringify({id:require("crypto").randomUUID(),from:S,to,text:t,kind:"direct",timestamp:ts}));require("fs").renameSync(B+"/inbox/"+to+"/"+fn+".tmp",B+"/inbox/"+to+"/"+fn+".json");
require("fs").appendFileSync(L,JSON.stringify({id:require("crypto").randomUUID(),from:S,to,text:t,kind:"direct",timestamp:ts})+"\\n");
console.log("JOIN_OK");
