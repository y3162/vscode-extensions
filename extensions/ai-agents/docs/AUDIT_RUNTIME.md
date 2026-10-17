# Runtime audit — AI Agents 0.10.0

2026-10-17。対象: Cursor SDK background lease、SDK terminal logs、Terminal Panel mirror、実ランタイムの子・Plan/Build・背景実行。GUI の成否とは別の証拠である。

## 実装監査と修正

- `CursorBackgroundRuntime.release()` は、自然終了して dispose 済みの executor に SDK の後続 cleanup が来た場合、同じ executor を再び dispose していた。worker disposal 後も同様。`WeakSet` で cleanup 済みの executor を記録し、実 cleanup を一度だけ行う。live executor の保持・PID と shell ID による interrupt の制限は維持する。
- SDK terminal log の本文先頭に exit footer がある場合と CRLF の場合に、終了コードが欠落していた。header は両形式を許可するのに footer だけ LF と先行改行を必須にしていたため。footer も両改行形式・本文先頭に対応した。
- Terminal Panel の mirror は新しいプロセスを起動せず、既存 process ID を購読する。Ctrl+C はその process ID の interrupt、view の close は購読解除だけ。遅れて返る list が新しい output を上書きしない回帰テストが既存である。
- Cursor の terminal logs は `~/.cursor/projects/<workspace>/terminals` を参照し、workspace directory の絞り込みと初回 PID が worker の子孫であることの確認で所有範囲を制限する。worker 専用 data directory ではない。interrupt も native manager の shell ID と PID、または再確認した ancestry に限定する。

## SDK patch の安全条件

`scripts/cursor-runtime-patch.mjs` は SDK `1.0.37` と `dist/cjs/464.js` の SHA256 `dfda676be168412734925d3803ce712a335a16109ba1e161f437584ab92b8906` に固定する。元の cleanup expression が一箇所だけであることも要求する。version・hash 不一致は build を失敗させる。SDK のインストール元を直接変更せず build output にコピーして patch する。

変更は `backgroundShellExecutor.dispose()` を worker lease の `release()` に一箇所置き換えるだけ。running shell が無くなれば 100 ms polling 後に cleanup し、worker disposal は retained executor を cleanup する。新しい idempotence 回帰テストは自然終了と worker 終了後の重複 callback を検証する。

## 実行環境

- Cursor CLI: `~/.local/bin/agent`、`2026.06.26-7079533`。
- PATH Codex: `~/.local/bin/codex`、`0.163.0`。拡張機能の default は依存の bundled CLI `0.162.1` なので区別する。
- モデル: runtime suite は実 model list に `composer-2.5` / `gpt-6-luna` があることを確認してから使う。
- inference は既存認証によるローカル CLI / App Server。クラウド上の agent job は作成しない。各 test は OS の temp directory 配下の `ai-agents-runtime-*` の隔離 Git workspace と session disposal による cleanup を持つ。

## テスト証拠

`npx tsx --test test/cursor-background-runtime.test.ts test/cursor-terminals.test.ts test/terminal-monitor.test.ts`: **11 passed / 0 failed**。sandbox の tsx IPC `EPERM` を受け、承認された sandbox 外実行で確認した。patch の version/hash 拒否と、置換を戻すと元ソースと完全一致することも成功した。共有 Cursor directory 内の他 worker の PID は一覧に登録せず interrupt も呼ばないことを追加検証した。

`npm run test:runtime`: **12 passed / 0 failed / 0 skipped**、375.44 秒。既存認証・sandbox を維持して実 CLI / App Server で実行した。

| Live case | Result |
| --- | --- |
| App Server 2 子並列 | 成功。異なる thread ID、`gpt-6-luna`、処理時間 9,771 / 10,769 ms、区間の重なりを確認 |
| Cursor ACP 2 子並列 | 成功。異なる tool ID / agent ID、backend が返した子モデルは両方 `composer-2.5-fast`、処理時間 14,870 / 14,841 ms。親の `composer-2.5` から推定していない |
| App Server background 自然終了・明示終了 | 成功。別会話表示中にも元 controller の final output と exit code 0 を反映。次の process ID `55770` は公開 terminate で消えた |
| App Server TerminalMonitor / Ctrl+C | 成功。process ID `75312` の実 stdout と元 process の終了、terminal list からの消滅を確認。OS SIGINT handler の実行を保証する意味ではない |
| Cursor SDK Plan → 改訂 → Build | 成功。`composer-2.5`、revision 2、Plan 中はファイル無し、同じ session、Build の重複防止、実ファイル内容 `revised\n` を検証 |
| Cursor ACP Plan → 改訂 → Build | 成功。`composer-2.5`、revision 2、同じ session、Plan 中のファイル不変更、実ファイル内容・重複防止を検証 |
| Codex App Server Plan → 改訂 → Build | 成功。`gpt-6-luna`、revision 2、同じ session、Plan 中のファイル不変更、実ファイル内容・重複防止を検証 |
| App Server 親 Stop 後の子 | 成功。2 子は Stop 直後も running のまま。18 秒後に一方 completed、他方 running、親終了後の状態更新 21 件を観測。両子を一律 completed/cancelled にしていない |
| Cursor SDK Task | 成功。sandbox を有効にした worker で本物の Task running → completed と子 shell の `CHILD_SANDBOX_OK` が最終回答に含まれることを確認 |
| Cursor SDK background 自然終了 | 成功。親回答後も running、実測 elapsed 120,201 ms 後に completed / exit code 0、`CURSOR_TERMINAL_DONE` を含む最終 stdout が到達 |
| Cursor SDK follow-up と Ctrl+C | 成功。次の ACK ターン後も同じ process ID が running、TerminalMonitor の Ctrl+C が native executor を interrupt し cancelled に遷移 |
| Cursor SDK session disposal | 成功。実 background `sleep 90` の PID が session disposal 後に存在しないことを OS の `kill(pid, 0)` / ESRCH で確認 |

suite 終了後の process inventory で、追跡した test parent / worker / sandbox helper / Python PID と runtime test command が残っていないことを確認した。`git diff --check` も成功。

## 制約

Cursor SDK の Task tool の検出と親の結果は取得できるが、ACP の `cursor/task` / Codex App Server の child thread 相当の全詳細を SDK が公開しているとは扱わない。未公開の実測 child model・background flag を親設定から補完しない。

この監査では実機 GUI 操作の成功を主張しない。GUI の証拠は別途の Extension Development Host 操作記録を参照する。


## 最終再監査の追加

今回のruntime初回はApp Server Plan/parentStopにusage_limit_exceededがあり、途中中断したため12/12成功とは扱わない。再試験で同2ケースは成功、ACP実並列子は200秒run timeoutで失敗。最終件数は総合検証の今回節を参照する。過去の12/12記録は今回の全成功証拠ではない。ACPの並列タイムアウトは拡張機能の合成イベント成功とは区別する。
