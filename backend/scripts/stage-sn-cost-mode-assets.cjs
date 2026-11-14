const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'../..'),src=path.join(root,'frontend/web/dist-sn-cost-mode-release'),dest=path.join(root,'backend/public'),files=[];
function copy(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const input=path.join(dir,e.name),rel=path.relative(src,input),output=path.join(dest,rel);if(e.isDirectory())copy(input);else{fs.mkdirSync(path.dirname(output),{recursive:true});fs.copyFileSync(input,output);files.push('backend/public/'+rel.replaceAll('\\','/'));}}}
copy(src);for(let i=0;i<files.length;i+=50)cp.execFileSync('git',['add','--',...files.slice(i,i+50)],{cwd:root,stdio:'pipe'});console.log('Staged build files: '+files.length);
