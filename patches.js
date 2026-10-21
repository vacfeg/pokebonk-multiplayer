// String patches applied to the game bundle at serve time. Each `find` must
// match exactly once; a mismatch is reported so a game update is noticed early.
// Top-level minified names change between game builds, so those anchors are
// regular expressions that capture the name instead of hard-coding it.

// The game bundle is recognised by its content, not its file name (the name
// changes with every PokéBonk release).
export const isGameBundle = (src) => src.includes('`https://api.pokebonk.com`') && src.includes('async boot()');

const PATCHES = [
  {
    name: 'local api',
    find: '`https://api.pokebonk.com`',
    replace: '`/api`',
  },
  {
    // Exposes the app instance so the LAN client can reach the active run.
    name: 'expose app',
    find: /async boot\(\)\{([\w$]+)\(this\)/g,
    replace: 'async boot(){window.__pbApp=this;$1(this)',
  },
  {
    // Lets the LAN client force the host's seed/biome on everyone's run.
    name: 'run config',
    find: /([\w$]+)=\{\.\.\.\1,seed:([\w$]+)\.seed,boosts:\2\.boosts\?\?\[\]\}/g,
    replace: '$1=(window.LAN?.runCfg??(x=>x))({...$1,seed:$2.seed,boosts:$2.boosts??[]})',
  },
  {
    // Host: each enemy chases the nearest living player, not just the host.
    name: 'enemy target',
    find: 'update(e){let t=this.run,n=t.player,r=t.terrain,i=n.pos.x,a=n.pos.z,o=n.pos.y;this.grid.build(this.n,this.x,this.z,this.alive);let s=this.grid.result;for(let l=0;l<this.n;l++){if(!this.alive[l])continue;',
    replace: 'update(e){let t=this.run,n=t.player,r=t.terrain,i=n.pos.x,a=n.pos.z,o=n.pos.y;this.grid.build(this.n,this.x,this.z,this.alive);let s=this.grid.result;const __m=window.LAN?.multi;for(let l=0;l<this.n;l++){if(!this.alive[l])continue;if(__m){LAN.pickTarget(this.x[l],this.z[l]);i=LAN.tx;a=LAN.tz;o=LAN.ty}',
  },
  {
    // Host: only push the host's own player when the enemy is chasing them.
    name: 'enemy crowd push',
    find: 'if(!(u&16512)){let e=this.x[l]-i,t=this.z[l]-a,s=(v+n.radius)*.8',
    replace: 'if(!(u&16512)&&(!__m||LAN.tHost)){let e=this.x[l]-i,t=this.z[l]-a,s=(v+n.radius)*.8',
  },
  {
    // Host: contact damage only hits the host when chasing the host; clients
    // resolve their own contact damage.
    name: 'enemy contact damage',
    find: 'if(!(u&16512)&&h<te&&',
    replace: 'if(!(u&16512)&&(!__m||LAN.tHost)&&h<te&&',
  },
  {
    // A defeated player (spectating a friend) stops attacking.
    name: 'dead players do not attack',
    find: /([\w$]+)\.moves\.forEach\(\(([\w$]+),([\w$]+)\)=>\{\2&&([\w$]+)\(this,\3,\2,([\w$]+)\)\}\)/g,
    replace: '$1.dead||$1.moves.forEach(($2,$3)=>{$2&&$4(this,$3,$2,$5)})',
  },
  {
    // Far-enemy recycling considers every player (and never runs on clients).
    name: 'far enemies',
    find: 'let t=a.x[e]-n.pos.x,r=a.z[e]-n.pos.z;if(t*t+r*r>5625&&',
    replace: 'let t=a.x[e]-n.pos.x,r=a.z[e]-n.pos.z;if((window.LAN?.farCheck?LAN.farCheck(a.x[e],a.z[e],t*t+r*r):t*t+r*r>5625)&&',
  },
];

// Returns { code, failed: [patch names that didn't match exactly once] }.
export function patchBundle(src) {
  let out = src;
  const failed = [];
  for (const p of PATCHES) {
    const count = typeof p.find === 'string'
      ? out.split(p.find).length - 1
      : (out.match(p.find) ?? []).length;
    if (count !== 1) {
      console.error(`[patch] "${p.name}" matched ${count} times (expected 1)`);
      failed.push(p.name);
      continue;
    }
    out = typeof p.find === 'string' ? out.replace(p.find, () => p.replace) : out.replace(p.find, p.replace);
  }
  return { code: out, failed };
}
