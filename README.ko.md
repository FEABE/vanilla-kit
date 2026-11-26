# vanilla-kit

**의존성 0개**, **파일 하나**로 된 작은 JavaScript 모듈 모음입니다. 모두 직접 작성했습니다.
번들러도, npm 패키지도, 압축기도, 제3자 코드도 쓰지 않습니다.

**파일 하나를 프로젝트에 복사하면 바로 동작합니다.** 모듈마다 테스트와 설명 절이 따로 있습니다.

[English README](README.md) — 옵션과 동작의 자세한 설명은 영어 README 가 기준입니다.

| 모듈 | 환경 | 크기 (원본 / gzip) | 한 줄 사용법 |
| --- | --- | --- | --- |
| [`browser/qr.js`](#qrjs) | 브라우저 + Node | 19.5 KB / 6.6 KB | `VanillaQR.toSvg(VanillaQR.encode('https://example.com'))` |
| [`browser/markdown.js`](#markdownjs) | 브라우저 + Node | 24.0 KB / 7.8 KB | `el.innerHTML = VanillaMarkdown.toHtml(src)` (기본값이 XSS 안전) |
| [`browser/diff.js`](#diffjs) | 브라우저 + Node | 6.6 KB / 2.7 KB | `VanillaDiff.diffLines(oldText, newText)` |
| [`browser/color.js`](#colorjs) | 브라우저 + Node | 8.3 KB / 3.3 KB | `VanillaColor.contrast(VanillaColor.parse('#777'), VanillaColor.parse('#fff'))` |
| [`node/zip.js`](#zipjs) | Node | 8.1 KB / 3.0 KB | `zip([{ name: 'a.txt', data: 'hi' }])` → `Buffer` |
| [`node/smtp.js`](#smtpjs) | Node | 13.9 KB / 5.2 KB | `await sendMail({ host, port, user, pass }, { from, to, subject, text })` |

크기는 주석을 포함한, 압축하지 않은 원본 기준입니다.

## 공통 규칙

- **브라우저 모듈**(`browser/`)은 작은 UMD 감싸개를 쓴 일반 스크립트입니다. `<script src>` 로 읽으면 전역
  (`window.VanillaQR`, `window.VanillaMarkdown` …)이 생기고, Node 에서는 `require()` 로 같은 객체를 받습니다.
  DOM API 를 쓰지 않으므로 워커와 서버에서도 동작하고, `eval`·인라인 스타일·네트워크 접근이 없어
  엄격한 CSP(`script-src 'self'`) 아래에서도 동작합니다.
- **Node 모듈**(`node/`)은 CommonJS 이며 Node 내장 모듈(`node:zlib`, `node:net`, `node:tls`, `node:crypto`)만 씁니다.
  ES 모듈 프로젝트에서는 파일 이름을 `.cjs` 로 바꿔 `import` 하거나 `node:module` 의 `createRequire` 를 쓰세요.
- **테스트**: `node --test` (Node 18 이상, 설치할 것 없음). 운영체제 도구나 최신 Node 가 필요한 검사는 없으면 건너뜁니다.
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

## 라이선스

[MIT](LICENSE) © 2026 FEABE
