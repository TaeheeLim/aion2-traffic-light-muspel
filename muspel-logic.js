"use strict";
/* =======================================================================
 * 무스펠의 성배 신호등 연습 — 게임 로직 (프레임워크 무관, 2D에서 1:1 포팅)
 * 렌더(쿼터뷰 / RPG 3인칭)와 분리되어 공용으로 사용된다. window.MUSPEL 로 노출.
 * 동작의 "정답" 레퍼런스: D:\project\traffic-light\index.html (2D)
 * ======================================================================= */
window.MUSPEL = (function(){
  const TAU=Math.PI*2, clamp=(v,a,b)=>Math.max(a,Math.min(b,v)), lerp=(a,b,t)=>a+(b-a)*t;
  const rand=n=>Math.floor(Math.random()*n);

  // colors: 0=빨,1=초,2=파 (순환 빨→초→파→빨…)
  const COL=[
    {hex:"#ff4d5e", rgb:0xff4d5e, name:"빨"},
    {hex:"#27d97a", rgb:0x27d97a, name:"초"},
    {hex:"#4db5ff", rgb:0x4db5ff, name:"파"},
  ];

  // ---- 월드 치수 (월드 유닛) ----
  const ARENA_R = 34;   // 구슬이 보스까지 지나는 거리(맵 크기) — 50→34로 축소
  const BOSS_R  = 4.0;
  const RING_R  = [BOSS_R+3.5, BOSS_R+2.2, BOSS_R+1.0]; // 바깥/중간/안쪽 (크게·분리)
  const ARRIVAL = BOSS_R+0.25;                            // 진입 판정 반지름
  const ORB_R   = 0.32;
  const PLAYER_R= 0.26;
  const BEAM_W  = 0.7;

  // ---- 게임 상수 (2D에서 그대로) ----
  const DOUBLE_CLOCKS=new Set([1,4,7,10]);
  const COMMIT=[3,5,7];     // 1·2·3번 구슬 진입 누적 폭발 횟수
  const ENTER_DELAY=1.5;    // 색 확정(임계 폭발 도달) 후 보스로 빨려들어가기 전 '대기(텀)' 시간(초)
  const SUCK_TIME=0.4;      // 텀이 끝난 뒤 실제로 보스에 빨려들어가는 연출 시간(초)
  const ARM_TIME=3.0;       // 장판 생성→폭발 주기 = 전체 속도
  const LOCK_FRAC=0.85;     // 장판이 캐릭터에서 분리·고정되는 충전 비율
  const BEAM_TOL=0.22;      // 장판 자석 정렬 허용각
  const COL_OFFSET=0.16;    // 두 줄(열) 사이 각도(약 9도)
  const MOVE_SPEED=4; // /초 (이동 속도, 맵 크기와 무관한 고정값)

  // ---- 시계 → XZ 좌표 ----
  function clockDirXZ(h){ const a=h*Math.PI/6; return {x:Math.sin(a), z:-Math.cos(a)}; }
  function clockAngle(h){ const d=clockDirXZ(h); return Math.atan2(d.z, d.x); }
  function angDiff(a,b){ let d=a-b; while(d>Math.PI)d-=TAU; while(d<-Math.PI)d+=TAU; return d; }

  // ---- 상태 (2D G와 동일한 모양) ----
  const G={
    clock:4, sound:true, running:false, wrong:0,
    rings:[0,1,2], ringGone:[false,false,false],
    cols:[], beam:null, fx:[],
    player:{x:0,z:0}, laneSeq:0, respawn:0,
    externalMove:false, // true면 update()가 키 입력 이동을 건너뜀(렌더 측에서 이동 제어)
    onGameOver:null, onBoom:null, onCast:null, onHit:null, // 렌더 측 훅
  };

  // ---- 반지름 계산 ----
  const spawnRadFor=tr=>ARRIVAL+(ARENA_R*0.97-ARRIVAL)*((tr+1)/3);
  function armFrac(){ return G.beam? clamp(G.beam.t/ARM_TIME,0,1):0; }
  function orbRad(col,orb){
    if(orb.entering){
      if(orb.enterT < ENTER_DELAY) return ARRIVAL;                              // 텀: 앞(보스 코앞)에서 대기
      const s=clamp((orb.enterT-ENTER_DELAY)/SUCK_TIME,0,1);                    // 그 뒤 빨려들어감
      return lerp(ARRIVAL, BOSS_R*0.25, s);
    }
    const eff=col.exp+armFrac();
    return lerp(spawnRadFor(orb.tr), ARRIVAL, clamp(eff/COMMIT[orb.tr],0,1));
  }

  // ---- 라운드 ----
  function newRings(){ // 빨/초/파 무작위 순열(반드시 서로 다른 3색)
    const a=[0,1,2]; for(let i=2;i>0;i--){const j=rand(i+1);[a[i],a[j]]=[a[j],a[i]];}
    G.rings=a; G.ringGone=[false,false,false];
  }
  function removeRing(i){ // 정답 구슬이 그 자리에 들어갈 때만 호출
    if(i>=0 && i<3 && !G.ringGone[i]){ G.ringGone[i]=true; G.fx.push({type:"ring",i,r:RING_R[i],col:COL[G.rings[i]].rgb,t:0}); }
  }
  // 3·5·7 폭발 스케줄 안에서 테두리 색으로 맞춰질 수 있는지 — (열수+1)^7 완전탐색
  function laneSolvable(cols){
    const n=cols.length, choices=n+1, total=Math.pow(choices,7);
    const need=cols.map(c=>c.orbs.map(o=>(((G.rings[o.tr]-o.cidx)%3)+3)%3));
    for(let mask=0; mask<total; mask++){
      let m=mask; const a=[]; for(let e=0;e<7;e++){a.push(m%choices);m=(m/choices)|0;}
      let ok=true;
      for(let ci=0; ci<n && ok; ci++){
        for(const o of cols[ci].orbs){
          let h=0; for(let e=0;e<COMMIT[o.tr];e++) if(a[e]===ci+1) h++;
          if(h%3!==need[ci][o.tr]){ ok=false; break; }
        }
      }
      if(ok) return true;
    }
    return false;
  }
  function makeCandidate(clock, base, cnt, id){
    const cols=[];
    for(let c=0;c<cnt;c++){
      const ang=base+(cnt===1?0:(c===0?-COL_OFFSET:COL_OFFSET));
      let cc; do{ cc=[rand(3),rand(3),rand(3)]; }while(cc[0]===cc[1]&&cc[1]===cc[2]); // 3개 모두 같은 색 금지
      const orbs=cc.map((v,i)=>({cidx:v,tr:i,committed:false,entering:false,enterT:0}));
      cols.push({laneId:id, clock, ang, exp:0, orbs, alive:true});
    }
    return cols;
  }
  // 난이도/다양성 점수: 색을 바꿔야 하는 구슬 수(주) + 등장 색 가짓수(보조)
  function laneDifficulty(cols){
    let changers=0; const colorset=new Set();
    for(const col of cols) for(const o of col.orbs){
      colorset.add(o.cidx);
      const need=(((G.rings[o.tr]-o.cidx)%3)+3)%3;
      if(need!==0) changers++;
    }
    return changers*10 + colorset.size;
  }
  function spawnLane(clock){
    const base=clockAngle(clock);
    const cnt=DOUBLE_CLOCKS.has(((clock%12)+12)%12||12)?2:1;
    const id=G.laneSeq++;
    let best=null;
    if(cnt===2){
      // 2줄: 7회 폭발로 항상 풀 수 있는(laneSolvable) 후보들 중 가장 어렵고 색이 다양한 조합 채택
      let bestScore=-1;
      for(let i=0;i<48;i++){
        const cand=makeCandidate(clock, base, cnt, id);
        if(!laneSolvable(cand)) continue;          // 풀이 보장 필수
        const sc=laneDifficulty(cand)+rand(3);      // 동점 시 약간의 무작위로 다양성 유지
        if(sc>bestScore){ bestScore=sc; best=cand; }
      }
    }
    if(!best){
      // 1줄(또는 2줄 후보 전부 실패한 드문 경우): 풀이 가능한 첫 조합
      let tries=0;
      do{ best=makeCandidate(clock, base, cnt, id); tries++; }while(!laneSolvable(best) && tries<400);
    }
    best.forEach(c=>G.cols.push(c));
  }
  function laneCount(){ const s=new Set(); G.cols.forEach(c=>{if(c.alive)s.add(c.laneId);}); return s.size; }

  // ---- 폭발 / 진입 ----
  function explode(){
    const b=G.beam;
    const reach=BEAM_W/2+ORB_R; // 닿음 판정 거리: 빔 중심선으로부터 (폭/2 + 구슬 반지름)
    // 줄(열)별로 '장판 범위에 닿은' 구슬을 모은 뒤, 한 번에 1줄만 변경
    let target=null;
    for(const col of G.cols){ if(!col.alive)continue;
      const touched=[];
      for(const o of col.orbs){ if(o.committed||o.entering)continue;
        const perp=Math.abs(orbRad(col,o)*Math.sin(angDiff(col.ang,b.ang))); // 빔 중심선까지 수직거리
        if(perp<=reach) touched.push(o);
      }
      if(!touched.length) continue;
      const adiff=Math.abs(angDiff(col.ang,b.ang));
      // 두 줄 동시 변경 금지: 닿은 구슬이 더 많은 줄 우선, 동수면 각도가 더 가까운 줄
      if(!target || touched.length>target.touched.length ||
         (touched.length===target.touched.length && adiff<target.adiff)) target={col,touched,adiff};
    }
    if(target) target.touched.forEach(o=>{ o.cidx=(o.cidx+1)%3; }); // 닿은 구슬만 빨→초→파 한 칸
    G.fx.push({type:"boom",ang:b.ang,len:ARENA_R,t:0});
    // 폭발 누적 → 임계 도달 구슬은 '진입 시작'(색 고정, 1초 뒤 실제 진입)
    for(const col of G.cols){ if(!col.alive)continue; col.exp++;
      for(const o of col.orbs){ if(!o.committed && !o.entering && col.exp>=COMMIT[o.tr]){ o.entering=true; o.enterT=0; } }
    }
    if(G.onBoom) G.onBoom();
    G.beam=null;
  }
  function commitOrb(col,o){
    o.committed=true;
    const want=G.rings[o.tr];
    const px=Math.cos(col.ang)*BOSS_R*0.6, pz=Math.sin(col.ang)*BOSS_R*0.6;
    if(o.cidx===want){ removeRing(o.tr); G.fx.push({type:"hit",x:px,z:pz,t:0,ok:true}); if(G.onHit)G.onHit(true); }
    else { G.wrong++; G.fx.push({type:"hit",x:px,z:pz,t:0,ok:false}); if(G.onHit)G.onHit(false); if(G.wrong>=2 && G.onGameOver) G.onGameOver(); }
  }

  // ---- 입력 키 ----
  const keys=new Set();

  // ---- 메인 업데이트 (2D update() 포팅) ----
  function update(dt){
    // 이동 (externalMove면 렌더 측이 G.player를 직접 갱신하므로 건너뜀)
    if(!G.externalMove){
      const sp=MOVE_SPEED*dt; let vx=0,vz=0;
      if(keys.has("ArrowUp")||keys.has("w")||keys.has("W"))vz-=1;
      if(keys.has("ArrowDown")||keys.has("s")||keys.has("S"))vz+=1;
      if(keys.has("ArrowLeft")||keys.has("a")||keys.has("A"))vx-=1;
      if(keys.has("ArrowRight")||keys.has("d")||keys.has("D"))vx+=1;
      if(vx||vz){const m=Math.hypot(vx,vz);G.player.x+=vx/m*sp;G.player.z+=vz/m*sp;}
    }
    // 반지름 클램프 (이동 주체와 무관하게 항상 아레나 안으로)
    let pd=Math.hypot(G.player.x,G.player.z)||1;
    const minD=BOSS_R+0.5, maxD=ARENA_R;
    if(pd<minD){G.player.x=G.player.x/pd*minD;G.player.z=G.player.z/pd*minD;}
    if(pd>maxD){G.player.x=G.player.x/pd*maxD;G.player.z=G.player.z/pd*maxD;}

    // 단일 레인 연습 — 비면 재스폰
    if(laneCount()===0){ if(G.respawn<=0)G.respawn=0.9; G.respawn-=dt; if(G.respawn<=0){ newRings(); spawnLane(G.clock);} }

    // 장판: 캐릭터 추종 → LOCK_FRAC에서 분리·고정 → 폭발
    if(G.cols.some(c=>c.alive)){
      const pa=Math.atan2(G.player.z,G.player.x);
      if(!G.beam) G.beam={t:0,ang:pa,locked:false};
      const b=G.beam;
      b.t+=dt;
      if(!b.locked){
        b.ang=pa; // 자동 타게팅(스냅) 제거 — 캐릭터가 보스 기준 향한 실제 방향 그대로 조준
        if(b.t>=LOCK_FRAC*ARM_TIME){ b.locked=true; if(G.onCast)G.onCast(); }
      }
      if(b.t>=ARM_TIME) explode();
    } else G.beam=null;

    // 진입 중 구슬: 보스로 빨려들어가고 ENTER_DELAY 후 commit
    for(const col of G.cols){ if(!col.alive)continue;
      for(const o of col.orbs){ if(o.entering && !o.committed){ o.enterT+=dt; if(o.enterT>=ENTER_DELAY+SUCK_TIME) commitOrb(col,o); } }
      col.orbs=col.orbs.filter(o=>!o.committed);
      if(col.orbs.length===0) col.alive=false;
    }
    G.cols=G.cols.filter(c=>c.alive);

    for(const f of G.fx) f.t+=dt;
    G.fx=G.fx.filter(f=>f.t<(f.type==="boom"?0.5:(f.type==="ring"?0.6:0.7)));
  }

  function playerAngle(){ return Math.atan2(G.player.z, G.player.x); }
  function placePlayerAtClock(clock){ const a=clockAngle(clock); G.player.x=Math.cos(a)*ARENA_R*0.42; G.player.z=Math.sin(a)*ARENA_R*0.42; } // 보스/링에 더 가깝게 시작
  function reset(){ G.cols=[]; G.beam=null; G.fx=[]; G.laneSeq=0; G.respawn=0; G.wrong=0; }
  function startRound(){ reset(); placePlayerAtClock(G.clock); newRings(); spawnLane(G.clock); }

  return {
    G, COL, keys,
    ARENA_R, BOSS_R, RING_R, ARRIVAL, ORB_R, PLAYER_R, BEAM_W, MOVE_SPEED,
    COMMIT, ENTER_DELAY, SUCK_TIME, ARM_TIME, LOCK_FRAC, BEAM_TOL, COL_OFFSET, DOUBLE_CLOCKS,
    clockDirXZ, clockAngle, angDiff, orbRad, update, newRings, spawnLane,
    placePlayerAtClock, playerAngle, reset, startRound, laneCount, laneSolvable,
  };
})();
