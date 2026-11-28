import {build} from 'vite';
import cp from 'node:child_process';
import path from 'node:path';
const root=process.cwd(),repo=path.resolve(root,'../..');
const files=cp.execFileSync('git',['diff','HEAD','--name-only','--','frontend/web/src'],{cwd:repo,encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
const overrides=new Map(files.map(f=>[path.resolve(repo,f).replaceAll('\\','/'),cp.execFileSync('git',['show',':'+f],{cwd:repo,encoding:'utf8'})]));
await build({plugins:[{name:'reviewed-index-source',enforce:'pre',load(id){if(!id.includes('?'))return overrides.get(id.replaceAll('\\','/'));}}],build:{outDir:'dist-sn-cost-mode-release'}});
