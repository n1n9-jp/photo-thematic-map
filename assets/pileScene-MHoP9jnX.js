import{J as e,M as t,Pt as n,Xt as r,b as i,j as a,kt as o,l as s,m as c,ot as l,u,v as d}from"./OrbitControls-BIOJiIEC.js";import{t as f}from"./enu-B7dnvlLZ.js";import{t as p}from"./field-ldWmegRt.js";import"./heapFill-B9kFDuot.js";import"./pile-DFvIX8BW.js";import{t as m}from"./paths-CqQefYGa.js";var h=1;function g(e,t,n){let r=new Worker(new URL(new URL(`pile.worker-Et0xy4cV.js`,import.meta.url).href,``+import.meta.url),{type:`module`,name:`pile-scene`}),i=h++;return new Promise((a,o)=>{r.onmessage=e=>{let t=e.data;t.id===i&&(t.type===`progress`?n?.(t.progress):(r.terminate(),t.type===`done`?a(t.result):o(Error(t.message))))},r.onerror=e=>{r.terminate(),o(Error(`山の計算の Worker でエラーが起きました: ${e.message}`))};let s={id:i,grid:e,publicRoot:m(``),params:t};r.postMessage(s)})}var _=1.6;function v(e,t){let n=e.length;if(n<2)return{k:0,a:0};let r=0,i=n-1;for(;i-r>1;){let n=r+i>>1;e[n]<=t?r=n:i=n}let a=e[r],o=e[r+1],s=o>a?Math.min(1,Math.max(0,(t-a)/(o-a))):1;return{k:r,a:s}}function y(e,t){let n=0,r=e.length;for(;n<r;){let i=n+r>>>1;e[i]<=t?n=i+1:r=i}return n}var b={full:.9,surface:.6},x={lift:.65,saturation:1.7,shadeFloor:.4},S=.65,C=.45,w=.03,T=.012;function E(){try{return typeof matchMedia==`function`&&matchMedia(`(prefers-reduced-motion: reduce)`).matches}catch{return!1}}async function D(e){let t=f({lat:e.lat,lon:e.lon}),n={x:t.x,z:t.z,count:e.count,mode:e.mode,unitVolume:e.unitVolume,seed:e.seed,surfaceDepth:e.surfaceDepth};return O(await(e.compute??g)(e.grid,n,e.onProgress),e)}function O(n,r={}){let i=n.mode,s=n.placedCount,c=n.representedCount,l=new a;l.name=`PileScene`;let{layerWidth:u,layerHeight:f,layerRect:m,fractions:h}=n,g=h.length,D=new d(n.layers,u,f,g);D.format=o,D.type=t,D.minFilter=e,D.magFilter=e,D.generateMipmaps=!1,D.needsUpdate=!0;let O=m.cellSize,k={x0:m.x0,z0:m.z0,sizeX:u*O,sizeZ:f*O},A=new p(r.field);A.tone=r.tone??x,A.deepShade=r.deepShade??.6,A.farFrameFill=S,A.reducedMotion=r.reducedMotion??E(),A.setPileSurface({texture:D,rect:k});let M=r.dropHeight??(i===`full`?60:70),N=i===`full`?Math.max(1,Math.round(r.fallWindow??c*.012)):0,P=A.addGroup({count:s,positions:n.positions,origin:n.origin,quaternions:n.quaternions,colors:n.colors,shades:n.shades,pile:i===`surface`?{height:n.pileHeight,spacing:n.spacing,maxLevel:n.maxLevel}:{height:n.pileHeight,hideAfter:n.hideAfter}},{reveal:0,fall:{height:M,window:N},pile:i===`surface`?{mode:`lattice`,shadeDepth:(r.surfaceDepth??.8)*1.3,latticeWindow:1}:{mode:`bury`,hideDepth:_+.4,shadeDepth:1.4}});l.add(A.object);let F=j(n,D,b[i],r.shellColor??5920080);l.add(F.mesh);let I=L(n,D);l.add(I.mesh);let R=n.layers.subarray((g-1)*u*f),z=1/0,B=1/0,V=-1/0,H=-1/0;for(let e=0;e<f;e++)for(let t=0;t<u;t++){if(R[e*u+t]===0)continue;let n=k.x0+(t+.5)*O,r=k.z0+(e+.5)*O;z=Math.min(z,n),V=Math.max(V,n),B=Math.min(B,r),H=Math.max(H,r)}let U={mode:i,site:n.site,apexY:n.apexY,apexHeight:n.apexHeight,volume:n.volume,area:n.area,representedCount:c,placedCount:s,bounds:{x0:z,z0:B,x1:V,z1:H},timings:n.timings,fillStats:n.fillStats},W=0,G=0,K=-1,q=!1,J=!1,Y=e=>y(n.arrivals,e),X=e=>i===`full`?Y(e):Math.round(Math.min(1,Math.max(0,e))*c),Z=()=>{let e=v(h,W),t={k0:e.k,k1:Math.min(g-1,e.k+1),mix:e.a},r;if(i===`surface`)r=A.reducedMotion?W:G;else{let e=A.getLandedCount(P);r=e<=0?0:e>=s?1:n.arrivals[Math.floor(e)-1],r=Math.min(W,r)}let a=v(h,r),o={k0:a.k,k1:Math.min(g-1,a.k+1),mix:a.a};A.setPileSurfaceStage(t,o),F.setStage(o),I.setStage(o)},Q={represented:0,shown:0,falling:0,field:A.stats,shellTriangles:0,triangles:0},$={object:l,field:A,info:U,result:n,get progress(){return W},setProgress(e,t={}){let n=Math.min(1,Math.max(0,Number.isFinite(e)?e:0));W=n;let r=Y(n);i===`surface`&&(t.midair?G=Math.max(0,n-T):G>n&&(G=n)),A.setRevealCount(r,P,t.midair&&i===`full`?{lead:0}:{}),Z()},representedCount(e){return X(e??W)},get pauseFalls(){return q},set pauseFalls(e){q=e,A.pauseFalls=e},get reducedMotion(){return A.reducedMotion},get animating(){return J},set reducedMotion(e){A.reducedMotion=e},stats:Q,update(e,t){let n=performance.now(),r=K<0?0:Math.min(.1,Math.max(0,(n-K)/1e3));K=n,i===`surface`&&(A.reducedMotion?G=W:!q&&G<W&&r>0&&(G=Math.min(W,G+Math.max((W-G)*(1-Math.exp(-r/C)),w*r)))),A.update(e,t),Z(),Q.represented=X(W),Q.shown=A.getRevealCount(P),Q.falling=A.stats.falling,Q.field=A.stats,Q.shellTriangles=(F.mesh.visible?F.triangles:0)+(I.mesh.visible?I.triangles:0),Q.triangles=A.stats.triangles+Q.shellTriangles,J=!q&&(A.stats.falling>0||i===`surface`&&!A.reducedMotion&&G<W)},dispose(){A.dispose(),F.dispose(),I.dispose(),D.dispose(),l.removeFromParent()}};return $.setProgress(0),$}var k=`
precision highp sampler2DArray;
uniform highp sampler2DArray uSurf;
uniform vec3 uStage;
uniform float uOffset;
uniform vec2 uTexel;
uniform float uCell;
attribute vec4 aNb;
attribute float aSink;
varying float vT;
varying vec3 vN;
float shellThick(vec2 p) {
  float a = texture(uSurf, vec3(p, uStage.x)).r;
  float b = texture(uSurf, vec3(p, uStage.y)).r;
  return max(0.0, mix(a, b, uStage.z));
}
void main() {
  float t = shellThick(uv);
  vT = t - uOffset;
  float hx1 = aNb.x + shellThick(uv + vec2(uTexel.x, 0.0));
  float hx0 = aNb.y + shellThick(uv - vec2(uTexel.x, 0.0));
  float hz1 = aNb.z + shellThick(uv + vec2(0.0, uTexel.y));
  float hz0 = aNb.w + shellThick(uv - vec2(0.0, uTexel.y));
  vN = normalize(vec3(-(hx1 - hx0) / (2.0 * uCell), 1.0, -(hz1 - hz0) / (2.0 * uCell)));
  vec3 p = position;
  // 積もっていない頂点は周囲の最も低い地表より下へ沈める（建物の屋上へ向かって面が立ち上がらないように）
  p.y = vT > 0.0 ? p.y + vT : aSink - 0.3;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`,A=`
uniform vec3 uColor;
uniform vec3 uLight;
varying float vT;
varying vec3 vN;
void main() {
  if (vT < 0.02) discard;
  float l = 0.55 + 0.45 * max(dot(normalize(vN), uLight), 0.0);
  gl_FragColor = vec4(uColor * l, 1.0);
  #include <colorspace_fragment>
}`;function j(e,t,a,o){let{layerWidth:d,layerHeight:f,layerRect:p,layerGround:m,fractions:h}=e,g=p.cellSize,_=h.length,v=new Float32Array(d*f*3),y=new Float32Array(d*f*2),b=new Float32Array(d*f*4),x=new Float32Array(d*f),S=(e,t)=>m[Math.min(f-1,Math.max(0,t))*d+Math.min(d-1,Math.max(0,e))];for(let e=0;e<f;e++)for(let t=0;t<d;t++){let n=e*d+t;v[n*3]=(t+.5)*g,v[n*3+1]=S(t,e),v[n*3+2]=(e+.5)*g,y[n*2]=(t+.5)/d,y[n*2+1]=(e+.5)/f,b[n*4]=S(t+1,e),b[n*4+1]=S(t-1,e),b[n*4+2]=S(t,e+1),b[n*4+3]=S(t,e-1);let r=1/0;for(let n=-1;n<=1;n++)for(let i=-1;i<=1;i++)r=Math.min(r,S(t+i,e+n));x[n]=r}let C=e.layers.subarray((_-1)*d*f),w=i.toHalfFloat(a),T=[];for(let e=0;e<f-1;e++)for(let t=0;t<d-1;t++){let n=e*d+t,r=n+1,i=n+d,a=i+1;Math.max(C[n],C[r],C[i],C[a])<=w||T.push(n,i,r,r,i,a)}let E=new u;E.setAttribute(`position`,new s(v,3)),E.setAttribute(`uv`,new s(y,2)),E.setAttribute(`aNb`,new s(b,4)),E.setAttribute(`aSink`,new s(x,1)),E.setIndex(T);let D=new r(-300,600,400).normalize(),O=new n({uniforms:{uSurf:{value:t},uStage:{value:new r(0,0,0)},uOffset:{value:a},uTexel:{value:[1/d,1/f]},uCell:{value:g},uColor:{value:new c(o)},uLight:{value:D}},vertexShader:k,fragmentShader:A}),j=new l(E,O);return j.name=`PileShell`,j.position.set(p.x0,0,p.z0),j.frustumCulled=!1,{mesh:j,triangles:T.length/3,setStage(e){O.uniforms.uStage.value.set(e.k0,e.k1,e.mix),j.visible=e.k0>0||e.mix>0},dispose(){E.dispose(),O.dispose(),j.removeFromParent()}}}var M=`
precision highp sampler2DArray;
uniform highp sampler2DArray uSurf;
uniform vec3 uStage;
uniform vec2 uTexel;
varying float vT;
float rimThick(vec2 p) {
  float a = texture(uSurf, vec3(p, uStage.x)).r;
  float b = texture(uSurf, vec3(p, uStage.y)).r;
  return max(0.0, mix(a, b, uStage.z));
}
void main() {
  // 周りの厚さの平均（ぼかし）。裾から外へ少しはみ出して薄くなる
  vec2 d = uTexel * 1.5;
  vT = (rimThick(uv) * 2.0 + rimThick(uv + vec2(d.x, 0.0)) + rimThick(uv - vec2(d.x, 0.0)) + rimThick(uv + vec2(0.0, d.y)) + rimThick(uv - vec2(0.0, d.y))) / 6.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,N=`
uniform vec3 uColor;
uniform float uAlpha;
varying float vT;
void main() {
  float a = uAlpha * smoothstep(0.0, 0.7, vT);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`,P=.45,F=3025444,I=1.6;function L(e,t){let{layerWidth:a,layerHeight:o,layerRect:d,layerGround:f,fractions:p}=e,m=d.cellSize,h=p.length,g=new Float32Array(a*o*3),_=new Float32Array(a*o*2);for(let e=0;e<o;e++)for(let t=0;t<a;t++){let n=e*a+t;g[n*3]=(t+.5)*m,g[n*3+1]=f[n]+.15,g[n*3+2]=(e+.5)*m,_[n*2]=(t+.5)/a,_[n*2+1]=(e+.5)/o}let v=e.layers.subarray((h-1)*a*o),y=i.toHalfFloat(I),b=[];for(let t=0;t<o-1;t++)for(let n=0;n<a-1;n++){let r=t*a+n,i=r+1,o=r+a,s=o+1,c=Math.max(v[r],v[i],v[o],v[s]),l=Math.min(v[r],v[i],v[o],v[s]);c===0||l>=y||Math.abs(f[r]-e.site.groundY)>6||b.push(r,o,i,i,o,s)}let x=new u;x.setAttribute(`position`,new s(g,3)),x.setAttribute(`uv`,new s(_,2)),x.setIndex(b);let S=new n({uniforms:{uSurf:{value:t},uStage:{value:new r(0,0,0)},uTexel:{value:[1/a,1/o]},uColor:{value:new c(F)},uAlpha:{value:P}},vertexShader:M,fragmentShader:N,transparent:!0,depthWrite:!1,blending:1,polygonOffset:!0,polygonOffsetFactor:-2,polygonOffsetUnits:-2}),C=new l(x,S);return C.name=`PileRimShadow`,C.position.set(d.x0,0,d.z0),C.frustumCulled=!1,C.renderOrder=-1,{mesh:C,triangles:b.length/3,setStage(e){S.uniforms.uStage.value.set(e.k0,e.k1,e.mix),C.visible=e.k0>0||e.mix>0},dispose(){x.dispose(),S.dispose(),C.removeFromParent()}}}export{O as n,g as r,D as t};