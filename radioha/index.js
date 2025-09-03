// index.js — Safari는 HLS로 302, 그 외는 MP3 변환
const port = 3005;
const atype_list = [256, 192, 128, 96, 48];
const mytoken = 'homeassistant';

const http = require('http');
const url = require('url');
const child_process = require('child_process');
const fs = require('fs');
const axios = require('axios');
const data = JSON.parse(fs.readFileSync('/app/radio-list.json', 'utf8'));

const instance = axios.create({ timeout: 3000 });

// [ADD] HLS(m3u8) URL 판별
function isHlsUrl(u) {
  const s = String(u || '').toLowerCase();
  return /\.m3u8(\?|$)/.test(s) || s.includes('playlist.m3u8') || s.includes('format=m3u8');
}

/* ---------------- UA/플랫폼 도우미 ---------------- */
// [NEW] 사파리 감지 (iOS+macOS)
function isSafari(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const hasSafari = /safari/.test(ua);
  const notChromium = !/chrome|crios|fxios|edgios|edg\//.test(ua);
  return hasSafari && notChromium;
}
function isIOSSafari(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  return /iphone|ipad|ipod/.test(ua) && isSafari(req);
}
// [NEW] 공급자 추정 (직접 URL일 때)
function guessProviderFromUrl(u) {
  const s = String(u).toLowerCase();
  if (s.includes('sbs.co.kr') || s.includes('gorealra')) return 'sbs';
  if (s.includes('imbc.com') || s.includes('sminiplay')) return 'mbc';
  if (s.includes('kbs')) return 'kbs';
  return null;
}

/* ---------------- CORS ---------------- */
function setCors(resp) {
  resp.setHeader('Access-Control-Allow-Origin', '*');
  resp.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Origin, Referer, User-Agent');
  resp.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

/* ---------------- Range 프루빙(0-1) ---------------- */
function handleRangeProbe(req, resp) {
  const range = req.headers.range || '';
  if (/^bytes=0-1$/.test(range)) {
    const probe = Buffer.from([0x49, 0x44]); // 'ID'
    setCors(resp);
    resp.writeHead(206, {
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes 0-1/2',
      'Content-Length': '2',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Connection': 'close',
    });
    resp.end(probe);
    return true;
  }
  return false;
}

/* ---------------- HLS 우회 리다이렉트 ---------------- */
// [MOD] 사파리 + m3u8 이면 방송사 구분 없이 전부 302 리다이렉트
function maybeRedirectToHLS(hlsUrl, req, resp, provider) {
  const q = url.parse(req.url, true).query || {};
  const forceMp3 = String(q.force || q.mp3 || q['force=mp3']).toLowerCase() === '1';
  if (forceMp3) return false;

  // 핵심: URL 자체가 m3u8이면, 사파리에서 바로 넘김
  if (isSafari(req) && isHlsUrl(hlsUrl)) {
    setCors(resp);
    resp.writeHead(302, {
      'Location': hlsUrl,
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    });
    resp.end();
    console.log('[redirect] Safari -> HLS 302:', hlsUrl);
    return true;
  }

  // (보너스) 방송사 기반 우회도 그대로 유지해도 무방
  if (!provider) provider = guessProviderFromUrl(hlsUrl);
  const isHlsProvider = provider === 'sbs' || provider === 'kbs' || provider === 'mbc';
  if (isHlsProvider && isSafari(req)) {
    setCors(resp);
    resp.writeHead(302, {
      'Location': hlsUrl,
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    });
    resp.end();
    console.log('[redirect] Safari(provider) -> HLS 302:', hlsUrl);
    return true;
  }

  return false;
}

/* ---------------- ffmpeg 입력 헤더 ---------------- */
function buildHttpHeadersForProvider(provider) {
  if (provider === 'sbs') {
    return {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_16_0) AppleWebKit/537.36 (KHTML, like Gecko) GOREALRA/1.2.1 Chrome/85.0.4183.121 Electron/10.1.3 Safari/537.36',
      headers: [
        'Origin: https://gorealraplayer.radio.sbs.co.kr',
        'Referer: https://gorealraplayer.radio.sbs.co.kr/main.html?v=1.2.1',
        'Accept: */*'
      ].join('\r\n'),
    };
  }
  if (provider === 'mbc') {
    return {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36',
      headers: ['Referer: http://mini.imbc.com/', 'Accept: */*'].join('\r\n'),
    };
  }
  if (provider === 'kbs') {
    return {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36',
      headers: ['Referer: https://onair.kbs.co.kr/', 'Accept: */*'].join('\r\n'),
    };
  }
  return {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    headers: 'Accept: */*',
  };
}

/* ---------------- MP3 스트리밍 (ffmpeg) ---------------- */
function streamMP3(urls, req, resp, bitrateK = 128, provider = null) {
  urls = String(urls).trim().replace(/^"+|"+$/g, '');
  const { userAgent, headers } = buildHttpHeadersForProvider(provider);

  setCors(resp);
  resp.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'Keep-Alive': 'timeout=5',
    'Transfer-Encoding': 'chunked',
    'Accept-Ranges': 'none',            // [CHG] Range 기대치 제거
    'X-Content-Type-Options': 'nosniff',
  });
  if (typeof resp.flushHeaders === 'function') resp.flushHeaders();

  // 아주 작은 ID3 헤더로 “바이트 수신 시작” 표시
  resp.write(Buffer.from([0x49,0x44,0x33,0x03,0x00,0x00,0x00,0x00,0x00,0x00]));

  const args = [
    '-nostdin', '-loglevel', 'error',
    '-analyzeduration','0', '-probesize','64k',
    '-fflags','nobuffer', '-flags','low_delay',
    '-rw_timeout','15000000',
    '-reconnect','1', '-reconnect_streamed','1', '-reconnect_delay_max','2',
    '-user_agent', userAgent, '-headers', headers,
    '-i', urls,
    '-map','0:a:0', '-sn','-dn',
    '-vn','-ac','2','-ar','44100',
    '-c:a','libmp3lame','-b:a',`${bitrateK}k`,
    '-f','mp3','pipe:1',
  ];
  const ff = child_process.spawn('ffmpeg', args, { detached: false });

  ff.stderr?.on?.('data', b => console.error('[ffmpeg]', String(b)));
  ff.stdout.pipe(resp);

  const endResp = () => { try { resp.end(); } catch {} };
  ff.on('exit', (code, sig) => { console.log(`[ffmpeg] exit code=${code} signal=${sig}`); endResp(); });
  ff.on('error', e => { console.error('[ffmpeg] error:', e); endResp(); });

  // [CHG] 'aborted'에서는 죽이지 않음 (사파리 프리로드에서 자주 발생)
  const kill = () => { console.log('[stream] client closed -> kill ffmpeg'); try { if (!ff.killed) ff.kill('SIGKILL'); } catch {} };
  req.on('close', kill);
  req.on('end', kill);
}

/* ---------------- 라우팅 헬퍼 ---------------- */
async function resolveUrlForKey(key) {
  const myData = data[key];
  if (!String(myData).includes('http')) {
    if (myData === 'kbs_lib') return await getkbs(key);
    if (myData === 'sbs_lib') return await getsbs(key);
    if (myData === 'mbc_lib') return await getmbc(key);
    return 'invaild';
  }
  return myData;
}

/* ---------------- HTTP 서버 ---------------- */
const liveServer = http.createServer(async (req, resp) => {
  try {
    if (req.method === 'OPTIONS') { setCors(resp); resp.writeHead(204); return resp.end(); }

    const { pathname, query } = url.parse(req.url, true);
    if (pathname !== '/radio') {
      setCors(resp);
      resp.statusCode = 403;
      resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return resp.end('올바르지 않은 접근');
    }

    const token_key = query['token'];
    if (token_key !== mytoken) {
      setCors(resp);
      resp.statusCode = 403;
      resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return resp.end('올바르지 않은 접근');
    }

    const key = query['keys'];
    console.log('your input : ' + key);
    if (!key || !Object.hasOwnProperty.call(data, key)) {
      setCors(resp);
      resp.statusCode = 403;
      resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return resp.end('올바르지 않은 코드');
    }

    const srcUrl = await resolveUrlForKey(key);
    if (srcUrl === 'invaild') {
      setCors(resp);
      resp.statusCode = 403;
      resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return resp.end('호출 실패');
    }

    // 공급자 추정
    let provider = null;
    const myData = data[key];
    if (!String(myData).includes('http')) {
      if (myData === 'kbs_lib') provider = 'kbs';
      if (myData === 'sbs_lib') provider = 'sbs';
      if (myData === 'mbc_lib') provider = 'mbc';
    } else {
      provider = guessProviderFromUrl(myData);
    }

    // [NEW] 사파리는 m3u8으로 302
    if (maybeRedirectToHLS(srcUrl, req, resp, provider)) return;

    // [기존] 그 외 브라우저는 MP3 변환
    const atype = Number(query['atype'] ?? 0);
    const bitrateK = atype_list[atype] ?? 128;
    if (handleRangeProbe(req, resp)) return;
    streamMP3(srcUrl, req, resp, bitrateK, provider);

  } catch (e) {
    console.error('[server] error:', e);
    try {
      setCors(resp);
      resp.statusCode = 502;
      resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
      resp.end('서버 오류');
    } catch {}
  }
});

/* ---------------- 방송사 API ---------------- */
function getkbs(param) {
  return new Promise(resolve => {
    const map = { 'kbs_1radio':'21','kbs_3radio':'23','kbs_classic':'24','kbs_cool':'25','kbs_happy':'22' };
    instance({
      method:'get',
      url:'https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/' + map[param],
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36',
        'referer':'https://onair.kbs.co.kr/'
      }
    }).then(r=>{
      const arr = r.data.channel_item || [];
      const it = arr.find(x=>x.media_type==='radio');
      resolve(it?.service_url || 'invaild');
    }).catch(_=>resolve('invaild'));
  });
}
function getmbc(ch) {
  return new Promise(resolve => {
    const map = { 'mbc_fm4u':'mfm', 'mbc_fm':'sfm' };
    instance({
      method:'get',
      url:'https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel='+map[ch]+'&callback=jarvis.miniInfo.loadOnAirComplete',
      headers:{
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36',
        'Referer':'http://mini.imbc.com/','Accept-Language':'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7','Accept-Encoding':'gzip, deflate'
      }
    }).then(r=>{
      const text = 'https://' + r.data.split('"https://')[1].split('"')[0];
      resolve(text || 'invaild');
    }).catch(_=>resolve('invaild'));
  });
}
function getsbs(ch) {
  return new Promise(resolve => {
    const map = { 'sbs_power':['powerfm','powerpc'], 'sbs_love':['lovefm','lovepc'] };
    instance({
      method:'get',
      url:'https://apis.sbs.co.kr/play-api/1.0/livestream/'+map[ch][1]+'/'+map[ch][0]+'?protocol=hls&ssl=Y',
      headers:{
        'Host':'apis.sbs.co.kr','Connection':'keep-alive',
        'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_16_0) AppleWebKit/537.36 (KHTML, like Gecko) GOREALRA/1.2.1 Chrome/85.0.4183.121 Electron/10.1.3 Safari/537.36',
        'Accept':'*/*','Origin':'https://gorealraplayer.radio.sbs.co.kr',
        'Sec-Fetch-Site':'same-site','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty',
        'Referer':'https://gorealraplayer.radio.sbs.co.kr/main.html?v=1.2.1',
        'Accept-Encoding':'gzip, deflate, br','Accept-Language':'ko'
      }
    }).then(r=>{
      let u = '';
      if (typeof r.data === 'object' && r.data) {
        const s = JSON.stringify(r.data); const m = s.match(/https?:\/\/[^"']+\.m3u8[^"']*/i); if (m) u = m[0];
      }
      if (!u && typeof r.data === 'string') {
        const t = r.data.trim();
        try { const o = JSON.parse(t); const s = JSON.stringify(o); const m = s.match(/https?:\/\/[^"']+\.m3u8[^"']*/i); if (m) u = m[0]; }
        catch { const m = t.match(/https?:\/\/[^"']+\.m3u8[^"']*/i); if (m) u = m[0]; }
      }
      if (u) { console.log('[getsbs] m3u8:', u); resolve(u); } else { console.error('[getsbs] m3u8 URL not found'); resolve('invaild'); }
    }).catch(e=>{ console.error('[getsbs] error:', e?.message || e); resolve('invaild'); });
  });
}

/* ---------------- 서버 시작 ---------------- */
liveServer.listen(port, '0.0.0.0', () => {
  console.log('Server running at http://0.0.0.0:' + port);
});
