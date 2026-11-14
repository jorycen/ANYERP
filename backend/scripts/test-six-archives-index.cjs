const cp=require('child_process'),path=require('path'),Module=require('module');
const root=path.resolve(__dirname,'../..'),overrides=new Map();
for(const file of cp.execFileSync('git',['diff','HEAD','--name-only','--','backend/src'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/).filter(f=>f.endsWith('.js'))){overrides.set(path.resolve(root,file),cp.execFileSync('git',['show',':'+file],{cwd:root,encoding:'utf8'}));}
const read=Module._extensions['.js'];Module._extensions['.js']=(m,f)=>overrides.has(f)?m._compile(overrides.get(f),f):read(m,f);
