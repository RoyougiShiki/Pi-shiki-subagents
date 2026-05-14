// Standalone Node script: poll messages.jsonl for round prompts.
// Usage: node persistent-poll.js <meetingId>
// Env: PI_AGENT_NAME, COLLABORATING_AGENTS_DIR
// Prints: ROUND:N:PHASE:promptText, END, or TIMEOUT
const B=process.env.COLLABORATING_AGENTS_DIR||require("path").join(require("os").homedir(),".pi/agent/collaborating-agents");
const L=B+"/messages.jsonl";
const S=process.env.PI_AGENT_NAME;
const Q=process.argv[2]||"";
let n=0;if(require("fs").existsSync(L)){const c=require("fs").readFileSync(L,"utf8").trim();n=c?c.split("\n").length:0;}
function poll(){return new Promise(r=>{let i=0;const iv=setInterval(()=>{i++;if(!require("fs").existsSync(L))return;const lines=require("fs").readFileSync(L,"utf8").trim().split("\n").filter(Boolean);if(lines.length<=n)return;n=lines.length;for(const ln of lines.slice(-10)){let e;try{e=JSON.parse(ln)}catch{continue}if(!e.text||e.from===S)continue;if(e.text.includes("[meeting:"+Q+"][phase:end]")){clearInterval(iv);r("END");return}const m=e.text.match(/\[meeting:([^\]]+)\]\[round:(\d+)\]\[phase:(opening|discussion|final)\]\[action:prompt\]/);if(m&&m[1]===Q){clearInterval(iv);r("ROUND:"+m[2]+":"+m[3]+":"+e.text.slice(0,800));return}}if(i>=40){clearInterval(iv);r("TIMEOUT")}},2000);});}
poll().then(r=>{console.log(r);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)});
