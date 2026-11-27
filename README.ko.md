# vanilla-kit

**의존성 0개**, **파일 하나**로 된 작은 JavaScript 모듈 모음입니다. 모두 직접 작성했습니다.
번들러도, npm 패키지도, 제3자 코드도 쓰지 않습니다. `.min.js` 를 만드는 압축기도 이 저장소의 모듈
([`browser/minify.js`](#minifyjs))입니다.

**파일 하나를 프로젝트에 복사하면 바로 동작합니다.** 모듈마다 테스트와 설명 절이 따로 있습니다.

[English README](README.md) — 옵션과 동작의 자세한 설명은 영어 README 가 기준입니다.

**브라우저에서 써 보기:** [QR](https://chlehdwns.dev/tools/qr/) · [마크다운](https://chlehdwns.dev/tools/markdown/) ·
[diff](https://chlehdwns.dev/tools/diff/) · [색 대비](https://chlehdwns.dev/tools/color/) · [압축기](https://chlehdwns.dev/tools/minify/)
— 각 페이지에 SRI 가 붙은 `<script>` 코드가 있습니다. **CDN:** [cdn.chlehdwns.dev](https://cdn.chlehdwns.dev/#vanilla-kit) (브라우저 모듈만)

의존성 없이 직접 만든 도구 모음:
[vanilla-arch](https://github.com/FEABE/vanilla-arch) (구성도) ·
[vanilla-kit](https://github.com/FEABE/vanilla-kit) (작은 모듈) ·
[vanilla-build](https://github.com/FEABE/vanilla-build) (빌드) ·
[vanilla-deploy](https://github.com/FEABE/vanilla-deploy) (배포)

| 모듈 | 환경 | 크기 (원본 / gzip) | 한 줄 사용법 |
| --- | --- | --- | --- |
| [`browser/qr.js`](#qrjs) | 브라우저 + Node | 19.5 KB / 6.6 KB | `VanillaQR.toSvg(VanillaQR.encode('https://example.com'))` |
| [`browser/markdown.js`](#markdownjs) | 브라우저 + Node | 24.0 KB / 7.8 KB | `el.innerHTML = VanillaMarkdown.toHtml(src)` (기본값이 XSS 안전) |
| [`browser/diff.js`](#diffjs) | 브라우저 + Node | 6.6 KB / 2.7 KB | `VanillaDiff.diffLines(oldText, newText)` |
| [`browser/color.js`](#colorjs) | 브라우저 + Node | 8.3 KB / 3.3 KB | `VanillaColor.contrast(VanillaColor.parse('#777'), VanillaColor.parse('#fff'))` |
| [`browser/minify.js`](#minifyjs) | 브라우저 + Node | 47.2 KB / 12.6 KB | `VanillaMinify.minify(src).code` (+ 명령줄 `bin/minify.js`) |
| [`node/zip.js`](#zipjs) | Node | 8.1 KB / 3.0 KB | `zip([{ name: 'a.txt', data: 'hi' }])` → `Buffer` |
| [`node/smtp.js`](#smtpjs) | Node | 14.0 KB / 5.2 KB | `await sendMail({ host, port, user, pass }, { from, to, subject, text })` |
| [`node/docx.js`](#docxjs) | Node | 11.8 KB / 4.2 KB | `docx({ title, body: [{ heading: 1, text: '제목' }, '문단'] })` → `Buffer` |
| [`node/websocket.js`](#websocketjs) | Node | 21.2 KB / 6.9 KB | `createServer({ server, path: '/ws' }).on('connection', c => c.on('message', ...))` |

크기는 주석을 포함한, 압축하지 않은 원본 기준입니다.

브라우저 모듈의 **압축본**은 [`dist/`](dist/) 에 있습니다(`dist/qr.min.js` …, `node scripts/build-min.js` 로 이
저장소의 압축기가 만듦). 개발할 때는 읽을 수 있는 원본, 운영에는 `.min.js` 를 쓰세요. 테스트 전체를 `dist/` 파일로
한 번 더 돌려 동작이 같은지 확인합니다(`test/minified.test.js`). 압축본 크기(원본 / gzip): qr 10.0 / 4.3 KB,
markdown 11.7 / 4.9 KB, diff 2.8 / 1.5 KB, color 4.3 / 2.1 KB, minify 24.9 / 8.4 KB.

브라우저 모듈 예제 페이지는 [`examples/demo/`](examples/demo/) 에 있습니다. `node examples/serve.js` 를 실행하고
`http://127.0.0.1:8080/examples/demo/` 를 여세요. 엄격한 CSP(`script-src 'self'; style-src 'self'`) 아래에서 동작합니다.

## 공통 규칙

- **브라우저 모듈**(`browser/`)은 작은 UMD 감싸개를 쓴 일반 스크립트입니다. `<script src>` 로 읽으면 전역
  (`window.VanillaQR`, `window.VanillaMarkdown` …)이 생기고, Node 에서는 `require()` 로 같은 객체를 받습니다.
  DOM API 를 쓰지 않으므로 워커와 서버에서도 동작하고, `eval`·인라인 스타일·네트워크 접근이 없어
  엄격한 CSP(`script-src 'self'`) 아래에서도 동작합니다.
- **Node 모듈**(`node/`)은 CommonJS 이며 Node 내장 모듈(`node:zlib`, `node:net`, `node:tls`, `node:crypto`)만 씁니다.
  ES 모듈 프로젝트에서는 파일 이름을 `.cjs` 로 바꿔 `import` 하거나 `node:module` 의 `createRequire` 를 쓰세요.
- **테스트**: `node --test` (Node 18 이상, 설치할 것 없음. `VANILLA_KIT_MIN=1` 이면 압축본만). 운영체제 도구나 최신 Node 가 필요한 검사는 없으면 건너뜁니다.
- **라이선스**: MIT.

## qr.js

QR 코드 인코더 (ISO/IEC 18004 모델 2). 모듈 행렬과 SVG 를 만듭니다.
숫자·영숫자·바이트(UTF-8) 모드, 버전 1–40 자동 선택, 오류 정정 L/M/Q/H, Reed–Solomon, 마스크 8개의 벌점 비교.

```js
const qr = VanillaQR.encode('https://example.com', { ecl: 'M' });
svgHost.innerHTML = VanillaQR.toSvg(qr, { border: 4, dark: '#111111' });
```

옵션: `ecl`, `minVersion`/`maxVersion`, `mask`(0–7), `mode`(글이 맞지 않으면 오류). 너무 길면 `code: 'TOO_LONG'` 오류.
`toSvg` 의 색은 16진수만 받습니다(그 밖의 값은 검정/흰색으로 바뀌어 속성을 깨뜨릴 수 없음).
미지원: 한자(Kanji) 모드, 혼합 세그먼트, ECI, Micro QR, 디코딩.

테스트: 표준 예제 "HELLO WORLD 1-M" 코드워드, 형식/버전 정보 표, 그리고 테스트 안의 독립 디코더로
버전 1–40 × 오류 정정 4단계를 모두 되읽어 RS 신드롬과 원문을 확인합니다.

## markdown.js

Markdown → HTML. **기본값 그대로 `innerHTML` 에 넣어도 안전**하도록 만들었습니다.

```js
el.innerHTML = VanillaMarkdown.toHtml(src);
VanillaMarkdown.toHtml(src, { targetBlank: false }); // 링크에 target="_blank" 를 붙이지 않음
```

보안 원칙:

- **원본의 HTML 은 절대 통과시키지 않습니다.** 모든 글자를 이스케이프하며, HTML 을 허용하는 옵션은 없습니다.
- 태그·속성 이름은 모듈 안의 고정 문자열뿐이고 속성 값은 모두 이스케이프합니다.
- 링크 주소는 `http:`·`https:`·`mailto:`·상대 주소만, 이미지는 `http:`·`https:`·상대 주소만 허용합니다.
  `javascript:`, `vbscript:`, `file:`, 그리고 **`data:image/…` 를 포함한 모든 `data:` 주소는 버리고 글자만 남깁니다.**
  스킴 안에 숨긴 공백·제어 문자도 걸러 냅니다.
- 링크에는 `rel="noopener noreferrer"` 를 붙입니다. 중첩 깊이와 괄호 탐색 길이에 한도가 있습니다.
- 외부 이미지는 허용하므로 렌더링 결과가 제3자 주소를 불러올 수 있습니다. 필요하면 CSP `img-src` 로 막으세요.

테스트: 문법 정답 비교, 알려진 XSS 공격 문자열, 속성 깨기 시도, 공격 조각으로 만든 무작위 문서 3000개 퍼징.

## diff.js

Myers 알고리즘(O((N+M)·D)) 줄·단어 비교. `diffLines`, `diffWords`, `hunks`(주변 문맥 줄 묶기), `stats`.
줄 번호는 1부터, CRLF 는 정규화합니다. 편집 거리가 4000 을 넘으면 가운데를 통째로 삭제+추가로 보고합니다
(정확하지만 최소는 아님 — 큰 입력에서 페이지가 멈추지 않게).

테스트: 무작위 300쌍을 결과로 다시 만들고, 같은 줄 수를 독립 LCS 계산과 비교(최소 편집 확인).

## color.js

색 읽기·변환과 WCAG 2.x 대비율. `parse`(HEX, `rgb()`, `hsl()`, 기본 색 이름 일부), `toHex`/`toRgbString`/`toHslString`,
`luminance`, `contrast`, `grade`, `suggest`(색상·채도는 두고 밝기만 바꿔 기준을 넘는 가장 가까운 색),
`formatRatio`(반올림이 아니라 버림 — 4.497 이 "4.50" 으로 보이지 않게).

## minify.js

JavaScript 압축기. 주석·공백을 지우고 지역 변수 이름을 줄입니다. 토크나이저와 언어 전체를 읽는 재귀 하강
구문 분석기(ES2024 스크립트·모듈)를 처음부터 직접 만들었습니다.

```js
VanillaMinify.minify(src);                        // { code, renamed, bindings, skipped }
VanillaMinify.minify(src, { mangle: false });     // 주석·공백만
VanillaMinify.minify(src, { keepFnames: true });  // 함수 이름 유지 (fn.name 을 읽는 코드)
```

```sh
node bin/minify.js app.js -o app.min.js           # 명령줄 (설치 없음, CRLF → LF 정규화)
```

- **추측하지 않고 실패합니다.** 프로그램 전체를 읽지 못하면(문법 오류, JSX, TypeScript, 데코레이터, `<!--` 주석)
  아무것도 만들지 않고 `.line` / `.col` 이 붙은 오류를 던집니다.
- `/` 가 정규식인지 나눗셈인지는 구문 분석기가 정합니다. 토크나이저의 추측이 틀리면 그 위치부터 다시 읽습니다.
- 줄바꿈은 자동 세미콜론 삽입(ASI)에 영향이 없을 때만 지웁니다. 남기는 라이선스 주석은 제자리에, 줄바꿈 없이 씁니다.
- 이름 줄이기는 보수적입니다. 맨 바깥 이름·속성 이름·레이블·export 는 바꾸지 않고, 직접 `eval`·`with`·
  `\u` 이스케이프 이름이 있으면 통째로 건너뜁니다. 블록 안 함수 선언(같은 이름의 바깥 변수 포함, Annex B),
  클래스 이름(`keepClassnames`, 기본 켜짐), `var` 로 다시 선언한 catch 매개변수는 그대로 둡니다.

테스트: 까다로운 구문마다 압축 전후를 실행해 비교(느슨한 모드·엄격 모드), 압축한 압축기의 출력이 원본 압축기와
바이트 단위로 같은지 확인. [`scripts/check-corpus.js`](scripts/check-corpus.js) 로 1,134개 파일 / 23.8 MB
(애플리케이션 코드와 큰 제3자 라이브러리)를 검사해 실패 0, 거부 0 (LF·CRLF 모두), 결과 크기는 입력의 61.9 %.

## zip.js

ZIP 작성기 (Node). 줄어들 때만 `node:zlib` deflate, 아니면 저장 방식.

```js
const { zip } = require('./zip.js');
fs.writeFileSync('out.zip', zip([{ name: 'a.txt', data: 'hi' }, { name: 'dir/' }], { date: new Date(2026, 0, 1) }));
```

- 이름은 항상 UTF-8 (일반 목적 비트 11). 날짜를 고정하면 결과가 바이트 단위로 같습니다.
- **위험한 이름은 오류**: 빈 이름, 절대 경로, 드라이브 문자, 역슬래시, `.`/`..`/빈 경로 조각, 제어 문자, 중복.
  ("zip slip" 경로 탈출 항목을 만들 수 없음)
- 한도(ZIP64 미지원): 항목 65535개, 항목·전체 4 GiB 미만. 넘으면 깨진 파일 대신 `RangeError`.

테스트: CRC-32 정답값과 `zlib.crc32` 비교, 독립 리더로 헤더 교차 검사, 이름 검사, 그리고 가능한 환경에서는
운영체제 도구(Windows `tar.exe`, PowerShell `Expand-Archive`, 또는 `unzip -t`)로 실제 압축 해제 후 바이트 비교.

## smtp.js

일반 텍스트 메일용 SMTP 클라이언트 (Node). **기본 호스트·기본 계정 정보는 없습니다.**

```js
const { sendMail } = require('./smtp.js');
await sendMail(
  { host: 'smtp.example.com', port: 465, user: 'me@example.com', pass: process.env.SMTP_PASS },
  { from: 'Me <me@example.com>', to: ['you@example.org'], subject: '안녕하세요', text: '본문' }
);
```

TLS 동작:

| 설정 | 동작 |
| --- | --- |
| `secure: true`, 또는 `secure` 없이 465 포트 | 처음부터 TLS (implicit TLS) |
| 그 밖의 포트 | 평문으로 붙은 뒤 **STARTTLS 필수**, 올린 뒤 기능 목록을 다시 읽음 |
| 서버가 STARTTLS 를 광고하지 않음 | `allowPlain: true` 가 아니면 **거절** |
| `allowPlain: true` 이고 `user` 가 있음 | `allowPlainAuth: true` 도 주지 않으면 **여전히 거절** (암호를 평문으로 보내지 않음) |
| `220` 과 TLS 핸드셰이크 사이에 데이터가 옴 | 세션 중단 (STARTTLS 명령 주입 방어) |

인증서는 기본으로 검증합니다(`rejectUnauthorized: true`, TLS 1.2 이상). 사설 CA 는 `ca` 로 넘기세요.

메시지 안전:

- 주소는 `addr@domain` 또는 `이름 <addr@domain>`. **CR·LF·NUL, 주소 안의 공백·꺾쇠, ASCII 가 아닌 주소 등
  잘못된 값은 연결을 열기 전에 오류**이므로 헤더 주입·SMTP 명령 주입이 불가능합니다.
- 제목의 CR/LF 는 공백으로 바꿉니다. ASCII 가 아닌 제목·이름은 RFC 2047 인코딩(75자 이하로 접기).
- Bcc 받는 사람은 헤더에 쓰지 않습니다. 받는 사람 하나라도 거절되면 `DATA` 전에 실패합니다.
- 오류에는 `err.transcript`(인증 정보는 가림)와 `err.replyCode` 가 붙습니다.

미지원: HTML·첨부(MIME multipart), SMTPUTF8, 파이프라이닝, OAuth2.

테스트: 테스트 파일 안의 가짜 SMTP 서버(실제 메일 없음)로 AUTH PLAIN/LOGIN, cc/bcc, 주입 시도, STARTTLS 거절,
평문 인증 차단, 자체 서명 인증서(`openssl` 이 있을 때)로 implicit TLS·STARTTLS, STARTTLS 주입을 확인합니다.

## docx.js

최소 Word 문서 작성기 (Node). 제목·문단·서식 있는 글(굵게·기울임·밑줄·취소선·코드)·가운데 정렬·쪽 나눔.
필요한 작은 ZIP 작성기를 같은 파일에 넣어 파일 하나로 복사할 수 있습니다.

```js
const { docx } = require('./docx.js');
fs.writeFileSync('report.docx', docx({ title: '주간 보고', body: [{ heading: 1, text: '주간 보고' }, '첫 문단', { text: [{ text: '굵게', bold: true }, ' 보통'] }] }));
```

- 모든 글자는 XML 이스케이프하고, XML 1.0 에 넣을 수 없는 글자(제어 문자, 짝 없는 서로게이트 등)는 지웁니다.
- 제목은 Word 기본 스타일(Title, Heading 1–3)을 써서 탐색 창·목차에 나타납니다.
- **외부 관계·그림·필드가 없어** 문서를 열어도 Word 가 바깥에서 아무것도 가져오지 않습니다.
- 미지원: 그림, 표, 목록, 머리글/바닥글, docx 읽기.

테스트: 독립 리더로 풀어 CRC 확인, 모든 파트를 엄격한 XML 검사기와 (Windows 에서는) .NET XML 파서로 확인,
관계·콘텐츠 형식이 실제 파트를 가리키는지, 마크업을 깨려는 입력이 글자 그대로 남는지 확인합니다.
개발 중 Microsoft Word 로 실제로 열어 확인했습니다.

## websocket.js

Node `http`/`https` 서버에 붙는 WebSocket 서버 (RFC 6455). 상태가 인스턴스마다 따로라 여러 개 만들 수 있습니다.

```js
const wss = createServer({ server, path: '/ws', allowedOrigins: ['https://example.com'] });
wss.on('connection', (client, req) => {
  client.on('message', (data, isBinary) => client.send(isBinary ? data : 'echo: ' + data));
});
```

주요 옵션: `allowedOrigins`(브라우저용 서버라면 꼭 설정 — 교차 사이트 WebSocket 탈취 방지), `verify(req)`,
`selectProtocol`, `maxClients`, `maxMessageBytes`(기본 1 MiB, 선언된 길이로 본문을 받기 전에 거절),
`maxBufferedBytes`(느린 클라이언트 보호, 1013 으로 닫음), `heartbeatMs`(기본 30초), `closeTimeoutMs`.
리스너에서 던진 예외는 서버의 `error` 이벤트로 알리고 연결·프로세스를 죽이지 않습니다.

프로토콜: 핸드셰이크 검사(400/426), 업그레이드 요청과 함께 온 바이트 처리, 마스킹 필수, RSV 비트, 조각 조립과 사이에
끼는 제어 프레임, 규칙 위반 1002, 잘못된 UTF-8 1007, 닫기 코드 검사와 응답. 미지원: permessage-deflate, 클라이언트
(Node 22+ 의 전역 `WebSocket` 이나 브라우저를 쓰세요).

테스트: Node 내장 `WebSocket` 클라이언트와 테스트가 직접 만든 원시 프레임으로 핸드셰이크, 1002/1007/1009 경우 전부,
한 번에 온 프레임 100개, ping/pong, 닫기, 백프레셔, 하트비트를 확인합니다.

## 라이선스

[MIT](LICENSE) © 2026 FEABE
