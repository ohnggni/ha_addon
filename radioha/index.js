// index.js (MP3 스트리밍 버전)

const port = 3005; // 포트 설정
const atype_list = [256, 192, 128, 96, 48];
const mytoken = 'homeassistant'; // 토큰 설정
const http = require('http');
const url = require('url');
const child_process = require('child_process');
const fs = require('fs');
const axios = require('axios');
const data = JSON.parse(fs.readFileSync('/app/radio-list.json', 'utf8')); // 라디오 주소 저장 파일 열기

const instance = axios.create({
  timeout: 3000,
});

/* ================================
   MP3 스트리밍 유틸 (ffmpeg → stdout)
   ================================ */
// [MOD] HLS를 pipe로 내보내던 방식 제거하고, 단일 연속 오디오 스트림(MP3)으로 전송
function streamMP3(urls, req, resp, bitrateK = 128) {
  // [MOD] 재생에 필요한 헤더를 먼저 전송 (iOS Safari가 엄격하게 검사)
  resp.writeHead(200, {
    'Content-Type': 'audio/mpeg',       // [MOD] 필수: 오디오 MIME 지정
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'Keep-Alive': 'timeout=5',
    'Transfer-Encoding': 'chunked',
    'Accept-Ranges': 'none',            // [MOD] 단일 스트림이므로 범위 요청 없음 명시
    'X-Content-Type-Options': 'nosniff',
  });

  // [MOD] ffmpeg로 upstream(HLS/AAС/MP3)을 받아 연속 MP3로 변환하여 stdout으로 내보냄
  const ffmpegArgs = [
    '-nostdin',
    '-loglevel', 'error',

    // [MOD] HLS 소스 재접속 안정화
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '2',

    '-i', urls,          // upstream URL (m3u8/aac/mp3 등)
    '-vn',
    '-ac', '2',
    '-ar', '44100',
    '-c:a', 'libmp3lame',
    '-b:a', `${bitrateK}k`,
    '-f', 'mp3',
    'pipe:1',
  ];

  const ffmpeg = child_process.spawn('ffmpeg', ffmpegArgs, { detached: false });

  // stdout을 응답으로 바로 파이프
  ffmpeg.stdout.pipe(resp);

  // 로깅 및 정리
  ffmpeg.on('exit', (code, signal) => {
    console.log(`[ffmpeg] exit code=${code} signal=${signal}`);
    // 스트림이 끊기면 응답도 종료
    try { resp.end(); } catch (_) {}
  });

  ffmpeg.on('error', (e) => {
    console.error('[ffmpeg] error:', e);
    try { resp.end(); } catch (_) {}
  });

  // [MOD] 클라이언트 연결 종료 시 ffmpeg도 종료
  const kill = () => {
    try {
      if (ffmpeg && !ffmpeg.killed) {
        ffmpeg.kill('SIGKILL');
      }
    } catch (_) {}
  };
  req.on('close', kill);
  req.on('aborted', kill);
  req.on('end', kill);
}

/* ===========================================
   기존 return_pipe 정리 (MP3 스트리밍 호출)
   =========================================== */
function return_pipe(urls, resp, req) {
  const urlParts = url.parse(req.url, true);
  let atype = urlParts.query['atype'];
  atype = atype === undefined ? 0 : Number(atype);
  const bitrateK = atype_list[atype] ?? 128;

  // [FIX] 예전 코드의 HLS 파이프/정의되지 않은 xffmpeg 제거
  // createHLSStream(urls, resp);    // ❌ 제거
  // xffmpeg 사용 부분 전체 제거    // ❌ 제거

  // [MOD] 단일 연속 MP3 스트림으로 전송
  streamMP3(urls, req, resp, bitrateK);
}

/* =========================
   HTTP 서버 및 라우팅
   ========================= */
var liveServer = http.createServer(async (req, resp) => {
  try {
    const urlParts = url.parse(req.url, true);
    const urlParams = urlParts.query;
    const urlPath = urlParts.pathname;

    if (urlPath === '/radio') {
      const token_key = urlParams['token'];
      if (token_key !== mytoken) {
        resp.statusCode = 403;
        resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return resp.end('올바르지 않은 접근');
      }

      const key = urlParams['keys'];
      console.log('your input : ' + key);
      if (!key) {
        resp.statusCode = 403;
        resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return resp.end('올바르지 않은 접근');
      }

      const myData = data[key];
      if (!Object.hasOwnProperty.call(data, key)) {
        resp.statusCode = 403;
        resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return resp.end('올바르지 않은 코드');
      }

      // 주소가 직접 URL이 아닌 경우: 방송사 API 통해 m3u8 받아오기
      if (!String(myData).includes('http')) {
        if (myData === 'kbs_lib') {
          const u = await getkbs(key);
          // [MOD] m3u8 포함 여부 검사를 제거하고(너무 제약적), 유효성만 확인
          if (u !== 'invaild') return return_pipe(u, resp, req);
        }
        if (myData === 'sbs_lib') {
          const u = await getsbs(key);
          if (u !== 'invaild') return return_pipe(u, resp, req);
        }
        if (myData === 'mbc_lib') {
          const u = await getmbc(key);
          if (u !== 'invaild') return return_pipe(u, resp, req);
        }

        // 실패 시
        resp.statusCode = 403;
        resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return resp.end('호출 실패');
      } else {
        // 직접 URL인 경우
        return return_pipe(myData, resp, req);
      }
    }

    // [MOD] 기타 경로
    resp.statusCode = 403;
    resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return resp.end('올바르지 않은 접근');
  } catch (e) {
    console.error('[server] error:', e);
    try {
      resp.statusCode = 502;
      resp.setHeader('Content-Type', 'text/plain; charset=utf-8');
      resp.end('서버 오류');
    } catch (_) {}
  }
});

/* =========================
   방송사별 소스 URL 얻기
   ========================= */
function getkbs(param) {
  return new Promise(function (resolve) {
    let kbs_ch = {
      'kbs_1radio': '21',
      'kbs_3radio': '23',
      'kbs_classic': '24',
      'kbs_cool': '25',
      'kbs_happy': '22',
    };
    try {
      instance({
        method: 'get',
        url:
          'https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/' +
          kbs_ch[param],
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36',
          referer: 'https://onair.kbs.co.kr/',
        },
      })
        .then((response) => {
          const kbs_src = response.data.channel_item;
          let media_src = '';
          for (let i = 0; i < kbs_src.length; i++) {
            if (kbs_src[i].media_type === 'radio') {
              media_src = kbs_src[i].service_url;
              break;
            }
          }
          resolve(media_src || 'invaild');
        })
        .catch((e) => {
          console.log(e);
          resolve('invaild');
        });
    } catch {
      resolve('invaild');
    }
  });
}

function getmbc(ch) {
  return new Promise(function (resolve) {
    try {
      let mbc_ch = {
        mbc_fm4u: 'mfm',
        mbc_fm: 'sfm',
      };

      instance({
        method: 'get',
        url:
          'https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=' +
          mbc_ch[ch] +
          '&callback=jarvis.miniInfo.loadOnAirComplete',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.71 Safari/537.36',
          Referer: 'http://mini.imbc.com/',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate',
        },
      })
        .then((response) => {
          const text = 'https://' + response.data.split('"https://')[1].split('"')[0];
          resolve(text || 'invaild');
        })
        .catch((e) => {
          console.log(e);
          resolve('invaild');
        });
    } catch {
      resolve('invaild');
    }
  });
}

function getsbs(ch) {
  return new Promise(function (resolve) {
    let sbs_ch = {
      sbs_power: ['powerfm', 'powerpc'],
      sbs_love: ['lovefm', 'lovepc'],
    };
    try {
      instance({
        method: 'get',
        url:
          'https://apis.sbs.co.kr/play-api/1.0/livestream/' +
          sbs_ch[ch][1] +
          '/' +
          sbs_ch[ch][0] +
          '?protocol=hls&ssl=Y',
        headers: {
          Host: 'apis.sbs.co.kr',
          Connection: 'keep-alive',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_16_0) AppleWebKit/537.36 (KHTML, like Gecko) GOREALRA/1.2.1 Chrome/85.0.4183.121 Electron/10.1.3 Safari/537.36',
          Accept: '*/*',
          Origin: 'https://gorealraplayer.radio.sbs.co.kr',
          'Sec-Fetch-Site': 'same-site',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
          Referer: 'https://gorealraplayer.radio.sbs.co.kr/main.html?v=1.2.1',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'ko',
          'If-None-Match': 'W/"134-0OoLHiGF4IrBKYLjJQzxNs0/11M"',
        },
      })
        .then((response) => {
          resolve(response.data || 'invaild');
        })
        .catch((e) => {
          console.log(e);
          resolve('invaild');
        });
    } catch {
      resolve('invaild');
    }
  });
}

/* =========================
   서버 시작
   ========================= */
liveServer.listen(port, '0.0.0.0', () => {
  console.log('Server running at http://0.0.0.0:' + port);
});
