#!/usr/bin/env node
// Secrets come from a file or environment, never command-line arguments.
import {readFile,writeFile} from 'node:fs/promises';
import {keys,createChannel,appendText,readChannel,subscribe} from '../src/client.ts';
const [command,origin,...args]=process.argv.slice(2);
async function secret(){
  const text=process.env.CHANNEL_KEY_FILE?await readFile(process.env.CHANNEL_KEY_FILE,'utf8'):process.env.CHANNEL_SECRET;
  if(!text)throw new Error('Set CHANNEL_KEY_FILE to the key file (or CHANNEL_SECRET).');
  return text.trim();
}
try {
  if(command==='new'){
    const file=args[0];if(!file)throw new Error('Usage: channel.mjs new ORIGIN NEW_KEY_FILE');
    const k=await keys();
    // Write first: a network failure must not lose the only copy of the secret.
    await writeFile(file,k.secret+'\n',{flag:'wx',mode:0o600});
    const created=await createChannel(origin,k.secret);console.log(JSON.stringify(created,null,2));
    console.error('Posting key saved in '+file+'. Keep it private, or share it with participants.');
  } else if(command==='create'){
    console.log(JSON.stringify(await createChannel(origin,await secret()),null,2));
  } else if(command==='post'){
    const epoch=args[0],id=args[1];if(!epoch)throw new Error('Usage: channel.mjs post ORIGIN EPOCH [MESSAGE_ID] < message.txt');
    const chunks=[];let size=0;
    for await(const chunk of process.stdin){size+=chunk.length;if(size>8192)throw new Error('Message exceeds 8 KiB.');chunks.push(chunk);}
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));
    console.log(JSON.stringify(await appendText(origin,await secret(),epoch,text,id),null,2));
  } else if(command==='read'){
    console.log(JSON.stringify(await readChannel(origin,args[0],args[1]),null,2));
  } else if(command==='follow'){
    const connection=subscribe(origin,args[0],batch=>console.log(JSON.stringify(batch)),reason=>{console.error(reason);process.exitCode=1;},args[1]);
    process.once('SIGINT',()=>connection.close());
  } else throw new Error('Commands: new ORIGIN KEY_FILE | create ORIGIN | post ORIGIN EPOCH [MESSAGE_ID] | read ORIGIN ADDRESS [CURSOR] | follow ORIGIN ADDRESS [CURSOR]');
} catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
