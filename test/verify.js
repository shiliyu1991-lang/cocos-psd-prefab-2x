'use strict';
const fs=require('fs'),path=require('path');
const proj=process.argv[2],PSD_W=960,PSD_H=640;
const pdir=path.join(proj,'assets/PSD/prefabs');
const pf=fs.readdirSync(pdir).find(f=>f.endsWith('.prefab'));
const arr=JSON.parse(fs.readFileSync(path.join(pdir,pf),'utf8'));
let pass=0,fail=0;const ok=(c,m)=>c?pass++:(fail++,console.log('  FAIL:',m));
let refErr=0;JSON.stringify(arr,(k,v)=>{if(k==='__id__'&&(typeof v!=='number'||v<0||v>=arr.length))refErr++;return v;});
ok(refErr===0,'__id__ refs');
const nodes=arr.map((o,i)=>({o,i})).filter(x=>x.o&&x.o.__type__==='cc.Node');
ok(nodes.length===12,'node count 12; got '+nodes.length);
ok(nodes.every(n=>/^[\x00-\x7F]+$/.test(n.o._name)),'ascii names');
const nonRoot=nodes.slice(1);
ok(nonRoot.every(n=>/^(Node_|Img_|Label_)/.test(n.o._name)),'all children prefixed');
// suffix (after prefix) must have <= 8 letters/digits
const suffixAlnum=n=>n.replace(/^(Node_|Img_|Label_)/,'').replace(/[^A-Za-z0-9]/g,'').length;
const tooLong=nonRoot.filter(n=>suffixAlnum(n.o._name)>8).map(n=>n.o._name);
ok(tooLong.length===0,'suffix<=8 alnum; offenders: '+tooLong.join(','));
const byName={};nodes.forEach(n=>byName[n.o._name]=n);
function wp(i){let x=0,y=0,c=arr[i];while(c&&c.__type__==='cc.Node'){x+=c._trs.array[0];y+=c._trs.array[1];c=c._parent?arr[c._parent.__id__]:null;}return{x,y};}
function ec(l,t,w,h){return{x:l+w/2-PSD_W/2,y:PSD_H/2-(t+h/2)};}
const exp={Img_BeiJing:[240,120,480,400],Label_BiaoTi:[380,150,200,40],Img_icon_Zhua:[640,140,64,64]};
for(const n in exp){const nd=byName[n];if(!nd){ok(false,'missing '+n);continue;}const w=wp(nd.i),e=ec.apply(null,exp[n]);ok(Math.abs(w.x-e.x)<0.5&&Math.abs(w.y-e.y)<0.5,'align '+n);}
// dedup: two star nodes both clamp to Img_icon_star and share spriteFrame uuid
const stars=nodes.filter(n=>n.o._name==='Img_icon_star'||n.o._name==='Img_icon_sta2');
ok(stars.length===2,'two star nodes; got '+stars.length);
const su=n=>{const c=arr[n.o._components[0].__id__];return c._spriteFrame&&c._spriteFrame.__uuid__;};
ok(stars.length===2 && su(stars[0])===su(stars[1]),'dedup star uuid shared');
ok(arr[byName['Img_BeiJing'].o._components[0].__id__]._type===1,'BeiJing sliced');
ok(arr[byName['Node_QueDing'].o._components[0].__id__].__type__==='cc.Button','btn Node_QueDing');
ok(arr[byName['Node_LieBiao'].o._components[0].__id__]._N$layoutType===2,'layout vertical');
ok(byName['Img_icon_Zhua'].o._contentSize.width===32,'@2x 32');
ok(arr[byName['Label_BiaoTi'].o._components[0].__id__]._string==='标题','Label keeps 标题');
console.log('VERIFY:',pass,'passed,',fail,'failed');process.exit(fail?1:0);
