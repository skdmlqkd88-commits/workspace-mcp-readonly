# Workspace MCP 읽기 전용

MCP 클라이언트에서 내가 지정한 프로젝트 폴더의 파일 목록을 보고, 이름을 검색하고, 텍스트 파일을 줄 단위로 읽는 도구입니다. 클라이언트가 로컬 프로세스를 시작하고 표준 입력·출력(stdio)으로 연결합니다. 서버는 네트워크 포트를 열지 않으며 별도 계정이나 API 키가 필요 없습니다.

## 설치

첫 버전의 대상 환경은 **Apple Silicon Mac(macOS arm64)**입니다. arm64 Node.js 22.23.4 이상 23 미만, npm 11.14.1, Xcode Command Line Tools의 clang과 macOS SDK가 필요합니다. Intel Mac, Linux, Windows, 원격 ChatGPT 연결은 지원 범위 밖입니다.

macOS 27.2 arm64, Node.js 22.23.4, npm 11.14.1, Apple clang 17.0.0 환경에서 세 도구의 목록·검색·읽기 흐름을 SDK smoke와 MCP Inspector CLI 2.16.0으로 확인했습니다. 최소 macOS 버전은 아직 확인하지 않았습니다.

GitHub에서 소스를 받은 뒤 이 프로젝트 폴더에서 실행합니다. 의존성 설치에는 npm 레지스트리 연결이 필요합니다. 빌드는 로컬에서 Node용 서버와 파일 접근을 담당하는 macOS helper를 준비합니다.

```sh
git clone https://github.com/skdmlqkd88-commits/workspace-mcp-readonly.git
cd workspace-mcp-readonly
npm ci
npm run build
npm test
npm run smoke
```

`npm run smoke`는 동봉된 예제 폴더만 열어 세 가지 도구를 차례로 호출합니다. 성공하면 `Smoke check passed.`를 표시합니다. 빌드 후에는 `dist/stdio.js`, `dist/workspace-fs-helper`, `dist/helper.sha256`과 설치된 의존성을 함께 보관합니다.

## MCP 클라이언트에 연결

stdio를 지원하는 **신뢰하는 로컬 클라이언트**에 아래 실행 파일과 인자를 등록합니다. 세 경로를 실제 절대 경로로 바꿉니다. 처음에는 이 저장소 안의 `examples/project`로 연결해 보세요. MCP Inspector를 사용한다면 아래 내용을 `inspector.json`으로 저장합니다.

```json
{
  "mcpServers": {
    "workspace-readonly": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/workspace-mcp-readonly/dist/stdio.js",
        "--root",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

연결을 승인하기 전에 `--root` 경로를 확인하세요. 폴더 인자에는 링크를 거치지 않는 실제 경로를 입력합니다. 대상 폴더로 이동해서 `pwd -P`로 확인할 수 있습니다. 클라이언트에서 정상적으로 연결을 종료하면 서버가 진행 중인 요청을 정리하고 열린 폴더와 임시 helper 사본을 정리합니다. 읽을 폴더를 바꾸려면 연결을 끊고 이 인자를 바꾼 뒤 다시 연결하세요.

MCP Inspector 2.16.0 CLI에서 도구 세 가지가 보이는지 확인합니다.

```sh
mcp-inspector --cli --config ./inspector.json --server workspace-readonly --format json --method tools/list
```

Inspector를 설치하지 않은 경우 첫 `mcp-inspector`를 `npx @modelcontextprotocol/inspector@2.16.0`으로 바꿔 실행할 수 있습니다. 이 명령은 npm 레지스트리에서 Inspector를 가져옵니다.

| 도구 | 예제 인자 | 결과 |
| --- | --- | --- |
| `list_files` | `{"path":".","depth":2}` | 예제 폴더의 디렉터리와 파일 경로 |
| `find_files` | `{"query":"guide","path":"."}` | 상대 경로에 `guide`가 들어가는 파일 |
| `read_file` | `{"path":"docs/guide.md","startLine":1,"maxLines":5}` | 예제 문서의 첫 다섯 줄 |

도구 응답의 첫 번째 텍스트에 JSON이 들어 있습니다. 목록과 검색은 `entries` 및 `nextCursor`를 반환합니다. `nextCursor`가 있으면 나머지 인자를 유지하고 `cursor`에 그 값을 넣어 이어 봅니다. 읽기는 `path`, `content`, `nextLine`을 반환합니다. `nextLine`이 있으면 다음 요청의 `startLine`에 넣습니다.

## 접근 범위와 제한

- 서버 시작 인자로 지정한 한 폴더 안에서만 탐색합니다. 도구에는 상대 경로를 넣습니다. 시스템 경로, 상위 폴더를 가리키는 경로, 심볼릭 링크, 하드 링크로 공유된 파일의 접근은 제한됩니다.
- 검색은 파일의 상대 경로와 검색어를 Unicode NFC로 정규화하고 소문자로 바꾼 다음, 검색어가 경로에 그대로 포함되는지 확인합니다. 파일을 열 때는 목록에서 받은 정확한 경로를 쓰세요.
- 숨김 경로, 빌드·의존성 폴더, 일부 자격 증명 파일명 및 알려진 자격 증명 패턴이 포함된 파일을 제한합니다. 줄을 일부만 요청하더라도 파일 전체를 분류합니다. 패턴에 잡히지 않는 민감 정보가 있을 수 있으므로 공유해도 되는 폴더를 선택하세요. 서버에 네트워크 연결이 없어도 클라이언트가 읽은 내용을 자체 모델이나 서비스에 전달할 수 있습니다.
- 목록과 검색은 깊이 1~8, 한 페이지 1~100개로 요청할 수 있습니다. 한 디렉터리 최대 4,096개 항목, 한 요청 최대 8,192개 검사 항목과 5초를 적용합니다. 첫 번째 텍스트에 들어 있는 결과 JSON은 UTF-8 기준 최대 64 KiB입니다. 폴더 내용이 바뀌면 첫 페이지부터 다시 조회하세요.
- 읽기는 1 MiB 이하의 UTF-8 텍스트를 대상으로 합니다. 바이너리, 잘못 인코딩된 텍스트, 응답 크기 상한을 넘는 한 줄은 거부합니다.

## 공개 버전과 이용 조건

첫 공개 버전은 **0.1.0**입니다. 프로젝트 자체 코드는 [MIT License](LICENSE)로 공개합니다. 저작권 표시와 허가문을 유지하면 사용·수정·재배포·상업적 이용이 가능합니다. 함께 사용하는 외부 패키지에는 각 패키지의 이용 조건이 적용되며, 원문은 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)에 보존했습니다.

현재 배포 경로는 이 GitHub 저장소와 Releases의 소스 압축본입니다. npm 레지스트리에는 게시하지 않습니다. `package.json`의 `private: true`는 실수로 npm에 게시하는 일을 막기 위한 설정입니다.

## 참고한 프로젝트

[DevSpace](https://github.com/Waishnav/devspace)의 작업공간 흐름과 [Chat2Codex](https://github.com/hzhaoy/chat2codex)의 대화·로컬 실행 분리 원칙에서 아이디어를 얻었습니다. 이 저장소는 해당 프로젝트와 별개로 개발한 읽기 전용 도구입니다.

MCP 연결에는 공식 [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)를 사용합니다.
