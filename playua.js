(function () {
  'use strict';

  // ===== PlayUa v33: movies-only + clean flag =====
  const MIN_SEEDERS = 3;
  const MOVIE_CATS  = '2000,2010,2020,2030,2040';

  const noty=(m,t)=>{ try{ Lampa.Noty.show(m,{time:t||2500}); }catch(_){} };
  const ensureScheme=u=>/^https?:\/\//i.test(u)?u:('http://'+u);
  const trimEnd=s=>s.replace(/\/+$/,'');
  const safeName=s=>(s||'video').replace(/[^\w\d]+/g,'.').replace(/\.+/g,'.').replace(/^\.+|\.+$/g,'') || 'video';

  const isSerial = m => !!m?.first_air_date && !m?.release_date;     // фільми мають release_date, серіали — first_air_date

  function jackettBase(){
    const raw=Lampa.Storage.field('jackett_url')||'';
    const key=Lampa.Storage.field('jackett_key')||'';
    if(!raw||!key) throw new Error('Вкажи jackett_url / jackett_key у Налаштуваннях');
    let base=ensureScheme(raw).replace(/\/jackett(\/.*)?$/,'');
    return { base: trimEnd(base), key };
  }

  function getMoviePayload(data){
    const m=data?.movie;
    if(!m) throw new Error('Немає data.movie');
    if(isSerial(m)) throw new Error('skip-serial'); // захист на випадок помилкового виклику
    const title=(m.title||m.name||'').trim();
    const orig =(m.original_title||m.original_name||title).trim();
    const year =((m.release_date||'0000')+'').slice(0,4); // тільки дата фільму
    if(!title) throw new Error('Не визначена назва фільму');
    const poster = m.poster_path ? `http://image.tmdb.org/t/p/w300${m.poster_path}` : '';
    return { title, orig, year, poster, full:m };
  }

  async function jSearchTorznab(query){
    const { base, key } = jackettBase();
    const qp=new URLSearchParams({apikey:key,t:'search',q:query});
    for(const c of MOVIE_CATS.split(',').map(s=>s.trim()).filter(Boolean)) qp.append('cat',c);
    const url=`${base}/api/v2.0/indexers/all/results/torznab/?${qp}`;
    try{
      const r=await fetch(url,{method:'GET',credentials:'omit',mode:'cors'});
      if(!r.ok) return [];
      const xml=new DOMParser().parseFromString(await r.text(),'application/xml');
      let items=[...xml.querySelectorAll('item')].map(it=>{
        const xt=s=>(it.querySelector(s)?.textContent||'').trim();
        const xa=n=>(it.querySelector(`torznab\\:attr[name="${n}"]`)?.getAttribute('value')||'').trim();
        const enc = it.querySelector('enclosure')?.getAttribute('url') || '';
        const magnet = xa('magneturl') || xa('magnetUrl') || '';
        const link = magnet && magnet.startsWith('magnet:') ? magnet : (xt('link') || enc || '');
        const size = Number(xt('size') || xa('size') || 0);
        const seed = Number(xa('seeders') || xa('peers') || 0);
        const tracker = (xa('jackettindexer')||xa('indexer')||'').toLowerCase();
        const trackerId=(xa('jackettindexerid')||'').toLowerCase();
        return { title:xt('title'), link, magnet, dl:enc||'', size, seed, tracker, trackerId };
      }).filter(x=> x.link && x.size>0 && x.seed>=MIN_SEEDERS);
      const tol = items.filter(x=> x.tracker.includes('toloka') || x.trackerId.includes('toloka'));
      if (tol.length) items = tol;
      items.sort((a,b)=> b.size - a.size);
      return items;
    }catch(_){ return []; }
  }

  async function jSearchJSON(query, meta){
    const { base, key } = jackettBase();
    const qp=new URLSearchParams();
    qp.set('apikey',key); qp.set('Query',query);
    qp.set('title',meta.title); qp.set('title_original',meta.orig);
    if(meta.year) qp.set('year',meta.year);
    qp.set('is_serial','0');
    for(const c of MOVIE_CATS.split(',').map(s=>s.trim()).filter(Boolean)) qp.append('Category[]',c);
    const url=`${base}/api/v2.0/indexers/all/results?${qp}`;
    try{
      const r=await fetch(url,{method:'GET',credentials:'omit',mode:'cors'});
      if(!r.ok) return [];
      const json=await r.json();
      const arr = Array.isArray(json)?json:(json?.Results||json?.results||json?.items||[]);
      let items=(arr||[]).map(x=>{
        const magnet=x.MagnetUri||x.MagnetUrl||x.magnet||'';
        const link=(magnet&&magnet.startsWith('magnet:'))?magnet:(x.Link||x.link||'');
        const size=Number(x.Size||x.size||0);
        const seed=Number(x.Seeders||x.seeders||x.Peers||x.peers||0);
        const tracker=(x.Tracker||x.tracker||'').toLowerCase();
        const trackerId=(x.TrackerId||x.trackerId||'').toLowerCase();
        return { title:x.Title||x.title||'', link, magnet, dl:'', size, seed, tracker, trackerId };
      }).filter(x=> x.link && x.size>0 && x.seed>=MIN_SEEDERS);
      const tol = items.filter(x=> x.tracker.includes('toloka') || x.trackerId.includes('toloka'));
      if (tol.length) items = tol;
      items.sort((a,b)=> b.size - a.size);
      return items;
    }catch(_){ return []; }
  }

  function tsBase(){
    const raw=Lampa.Storage.field('torrserver_url')||'';
    if(!raw) throw new Error('Вкажи torrserver_url у Налаштуваннях');
    return trimEnd(ensureScheme(raw));
  }
  async function proxyAdd(base, addLink, meta){
    const url=`${base}/torrents`;
    const body={
      action:'add',
      link:addLink,
      title:`[LAMPA] ${meta.title} ${meta.year?`(${meta.year})`:''}`.trim(),
      poster: meta.poster || '',
      data: JSON.stringify({ lampa:true, movie: meta.full }),
      save_to_db:false
    };
    const r=await fetch(url,{method:'POST',body:JSON.stringify(body)});
    let j={}; try{ j=await r.json(); }catch(_){}
    const id = j.id || j.link || j.hash || j.data || j.result || '';
    if(!id) throw new Error('Proxy: не повернув id');
    return String(id);
  }
  function tsPlay(base, linkParam, title){
    const fname = safeName(title||'video') + '.mkv';
    const url = `${base}/stream/${encodeURIComponent(fname)}?link=${encodeURIComponent(linkParam)}&index=0&play=1`;
    if (Lampa?.Player?.play) Lampa.Player.play({ url, title: title||fname, timeline:0 });
    else location.href = url;
  }

  async function runPlay(data){
    let meta;
    try { meta = getMoviePayload(data); }
    catch (e) {
      if (String(e&&e.message)==='skip-serial') return; // тихо ігноруємо серіали
      throw e;
    }

    const combos={
      df:meta.orig,
      df_year:`${meta.orig} ${meta.year}`,
      df_lg:`${meta.orig} ${meta.title}`,
      df_lg_year:`${meta.orig} ${meta.title} ${meta.year}`,
      lg:meta.title,
      lg_year:`${meta.title} ${meta.year}`,
      lg_df:`${meta.title} ${meta.orig}`,
      lg_df_year:`${meta.title} ${meta.orig} ${meta.year}`
    };
    const pref=Lampa.Storage.field('parse_lang')||'df_year';
    const query=(combos[pref]||`${meta.orig} ${meta.year}`).trim();

    noty('PlayUa: шукаю — '+query);

    let items = await jSearchTorznab(query);
    if(!items.length) items = await jSearchJSON(query, meta);
    if(!items.length) throw new Error('Jackett: немає результатів');

    const best    = items[0];
    const addLink = best.dl || best.magnet || best.link;

    const base = tsBase();
    let linkParam = addLink;
    try { linkParam = await proxyAdd(base, addLink, meta); } catch(_){ linkParam = addLink; }

    noty('Запускаю відтворення…');
    tsPlay(base, linkParam, meta.title);
  }

  // ---- 🇺🇦 стиль без «смуги» ----
  function injectUAStyles(){
    if (document.getElementById('playua-ua-style')) return;
    const css = `
      .full-start__button.playua-btn{
        /* безшовний прапор: трохи розсуваємо межу 50% щоб уникнути сабпіксельної лінії */
        background-image: linear-gradient(180deg,#005BBB 0,#005BBB 49.8%,#FFD500 50.2%,#FFD500 100%) !important;
        background-color: transparent !important;
        color:#fff !important;
        border: 0 !important;                 /* прибрав тонку рамку */
        outline: 0 !important;
        box-shadow: 0 2px 8px rgba(0,0,0,.28) !important; /* без inset */
        overflow: hidden;                      /* ховає можливі артефакти країв */
      }
      .full-start__button.playua-btn.selector.focus,
      .full-start__button.playua-btn:hover{
        filter: brightness(1.06) contrast(1.02);
        transform: translateY(-1px);
      }
      .full-start__button.playua-btn svg{ color: currentColor; }
    `;
    const s=document.createElement('style');
    s.id='playua-ua-style';
    s.textContent=css;
    document.head.appendChild(s);
  }

  function findButtonsBar(root){
    let bar = root.find('.full-start-new__buttons').eq(0);
    if (bar && bar.length) return bar;
    bar = root.find('.full-start__buttons').eq(0);
    if (bar && bar.length) return bar;
    bar = root.find('.full-actions').eq(0);
    if (bar && bar.length) return bar;
    return root.find('.full-start__right, .full-start').eq(0);
  }

  function makeButton(){
    return $(`
      <div class="full-start__button selector playua-btn" data-playua-icon="1" tabindex="0" aria-label="PlayUa">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="28" height="28" aria-hidden="true">
          <path d="M20 15l20 10-20 10V15z" fill="currentColor"/>
        </svg>
        <span>PlayUa</span>
      </div>`);
  }

  function attachButtonOnce(root, ev){
    // показуємо кнопку лише на фільмах
    const m = ev?.data?.movie;
    if (!m || isSerial(m)) return true; // "handled" — не намагаємось вставляти ще

    const bar = findButtonsBar(root);
    if (!bar || !bar.length) return false;
    if (bar.find('[data-playua-icon="1"]').length) return true;

    const btn = makeButton();
    btn.on('hover:enter', ()=>{ (async()=>{ try{ await runPlay(ev.data); } catch(err){ noty('PlayUa: '+(err.message||err),4500); } })(); });
    btn.on('click',      ()=>{ (async()=>{ try{ await runPlay(ev.data); } catch(err){ noty('PlayUa: '+(err.message||err),4500); } })(); });
    btn.on('keydown', (e)=>{ if(e.key==='Enter'||e.keyCode===13){ (async()=>{ try{ await runPlay(ev.data); } catch(err){ noty('PlayUa: '+(err.message||err),4500); } })(); } });

    bar.prepend(btn);
    try { Lampa.Controller.collectionSet(bar); } catch(_) {}
    return true;
  }

  function mountTVNative(){
    injectUAStyles();

    Lampa.Listener.follow('full', function(ev){
      if (ev.type !== 'complite' || !ev.object) return;
      const root = ev.object.activity.render();
      if (attachButtonOnce(root, ev)) return;
      try{
        const target = root[0] || root;
        const mo = new MutationObserver(()=>{ if (attachButtonOnce(root, ev)) mo.disconnect(); });
        mo.observe(target, {childList:true, subtree:true});
        setTimeout(()=>mo.disconnect(), 8000);
      }catch(_){}
    });
  }

  if(!window.plugin_playua_ready){
    window.plugin_playua_ready = true;
    try { mountTVNative(); } catch(_) {}
  }
})();
