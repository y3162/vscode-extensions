# AI Agents UI 実装仕様（2026-10-28）

この文書が次の実装の契約である。Cursor のクラス名は移植しない。DOM は Webview の中で作り替える。Extension Host、CLI、セッション保存は維持する。Thinking の本文が無いときに文章を作らない。

根拠の記号は [CURSOR_UI_REVERSE_ENGINEERING_2026.md](CURSOR_UI_REVERSE_ENGINEERING_2026.md) と同じ。2026-10-29 の会話画面は [CURSOR_UI_CHAT_LIVE_2026.md](CURSOR_UI_CHAT_LIVE_2026.md) と [CURSOR_UI_CHAT_SPEC_DELTA_2026.md](CURSOR_UI_CHAT_SPEC_DELTA_2026.md)。レイアウトの見た目は [ui-redesign-preview/cursor-spec-2026.html](ui-redesign-preview/cursor-spec-2026.html)。

## 0. 2026-10-29 の改訂

実測したのは通常ワークベンチのチャット列である。空の Agents Window ではない。変更前と、採否は差分文書の表が正本である。

| 箇所 | 変更前 | 変更後 | 種別 |
| --- | --- | --- | --- |
| Composer 操作行 | 高さ 40px | 高さ 28px。箱の padding は `8px 10px 6px 10px` | 実測。40px は空ホームの記録として残す |
| Composer の枠 | 前景 12% | 前景 20% | 実測 |
| 活動見出し | 12px | 14px、行高 22px、最小高さ 22px | 実測。12px はレビュー帯のラベルに残す |
| ユーザー本文 | 14px、行高 1.57 | エディタの文字サイズ。行高は約 1.4 | 実測は 13px / 18.2px。13px は固定しない |
| レビュー | 件数、増減、Review | 未受け入れは件数、Undo、Keep、Review。受け入れ後は件数と Review。増減は帯に必須にしない | 実測。増減を外すのは未出現のため |
| ユーザー背景 | input 背景 | 変更なし | 実測は半透明だった。Webview には採らない |
| Build の色 | テーマのボタン | 変更なし | Dark の琥珀色は採らない |
| 640px 列 | 最大 640px、中央 | 変更なし | この会話画面では未出現 |

## 1. デザインシステム

色は VS Code テーマ変数だけを使う。計測した `srgb(0.130…)` と角丸 20px は Agents Window の空 Composer の値であり、サイドバーにはハードコードしない（A を記録し、E で不採用）。

| トークン | 値 | 根拠 |
| --- | --- | --- |
| `--agent-bg` | `var(--vscode-sideBar-background)` | サイドバー地 |
| `--agent-fg` | `var(--vscode-foreground)` | |
| `--agent-muted` | `var(--vscode-descriptionForeground)` | |
| `--agent-stroke` | `color-mix(in srgb, var(--vscode-foreground) 12%, transparent)` | B。ユーザーカード。会話画面でも白 12% |
| `--agent-stroke-strong` | `color-mix(in srgb, var(--vscode-foreground) 20%, transparent)` | 会話 Composer の枠。hover にも使う |
| `--agent-fill` | `var(--vscode-input-background)` | B。ユーザーカード |
| `--agent-radius` | `12px` | A の `--cursor-radius-xl` と B の会話 surface |
| `--agent-radius-row` | `4px` | B。活動行 |
| `--agent-radius-pill` | `999px` | A。モデルトリガー |
| `--agent-font` | `var(--vscode-font-family)` | テーマ。Cursor の 13px 固定は使わない |
| `--agent-line` | `1.57` | 回答本文。実測 22/14 |
| `--agent-line-user` | `1.4` | ユーザーカード。実測 18.2/13 |
| `--agent-gap-turn` | `16px` | B。`--conversation-block-gap` |
| `--agent-gap-step` | `6px` | B |
| `--agent-gutter` | `12px` | E。300px で 40px 余白は狭すぎる |
| `--agent-column` | `min(100%, 640px)` | A/B。広いときだけ中央 |

High Contrast では `color-mix` の枠がテーマの `widget-border` より弱い場合、枠を `var(--vscode-contrastBorder, var(--agent-stroke))` にする。

フォーカスは既存どおり `outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px`。hover で枠を `--agent-stroke-strong` にする。active は opacity 0.9。disabled は opacity 0.45。

アイコンは既存の codicon。活動行の chevron は 12px。送信は 24×24 の円。

幅:

| Webview 幅 | 列 | gutter | モデル名 |
| --- | --- | --- | --- |
| 300–599 | 100% | 12px | 最大 8em、ellipsis |
| 600–679 | 100% | 16px | 最大 16em |
| 680 以上 | 最大 640px、中央 | 16px | 最大 16em |

300 / 390 / 600 / 1000 の確認対象はこの表である。Agents Window で測った 40px インセットは、空のホームの値として記録し、サイドバーの gutter には使わない（E）。

## 2. 画面の縦構造

上から下へ、高さ 100% の column。

1. ヘッダー 40px。戻る、タイトル ellipsis、新規、設定。実行中はタイトル横に 6px の点（`progressBar`）。
2. スレッド。`overflow: auto`。padding は上 16px、左右 gutter、下 24px。ターン間隔 16px。
3. 変更バー。変更が 0 件なら出さない。
4. 承認カード。pending が無いときは出さない。
5. Composer。下端に置く。空のホームでも中央へ動かさない（E。Webview はサイドバーなので、計測した中央ホームは再現しない）。

680px 以上では 2 から 5 の中身を同じ 640px 列に入れる。

## 3. User Message

目的: 依頼と添付を、回答の地と区別する。

DOM:

```html
<article class="turn">
  <div class="user-card">
    <div class="user-body"></div>
    <ul class="chips"></ul>
    <div class="user-actions" hidden></div>
  </div>
</article>
```

- 列幅 100%。右寄せにしない。`max-width` で縮めない。会話画面でも内容列を埋めていた。project-send の 480px 吹き出しは不採用
- 背景 `--agent-fill`、枠 1px `--agent-stroke`、角丸 12px、padding 8px 10px、内部 gap 6px。Cursor のカード外側 padding は 0 で、背景は半透明だった。Webview では input 背景と 8px 10px を維持する
- 本文は pre-wrap。line-height は `--agent-line-user`。文字サイズはエディタのフォントに合わせ、14px には上げない
- 添付は本文の下の chip。ファイル名のみ。フルパスは `title` に置き、画面の主テキストにしない
- 操作（編集、再送、入力へ戻す）は hover または focus-within まで `opacity: 0`。キーボードでは focus-within で出す
- 長文はカード内で折り返す。カード自体は畳まない
- 既存の右寄せ吹き出し用ルールは削除する

データ: `TurnModel.user`。変更なし。

## 4. Activity

完了ターンの既定は 1 行。`作業時間 5m 25s`。形式は Cursor の `S6a` と同一（B）。

- `endedAt - startedAt` が 1 以上のときだけ出す
- 実行中で未確定なら `作業中`
- キャンセルで経過が取れていれば `作業時間` のうしろに `· 中断`
- 時間が無い完了ターンは行を出さない。`0s` と書かない

展開（B のグループ、表示変換だけで作る）:

| 条件 | 実行中 | 完了 | 詳細 |
| --- | --- | --- | --- |
| thinking があり本文が空でない | Thinking | Thought、または先頭見出し | 秒。本文は 500ms 未満なら `briefly` |
| thinking の本文が空 | 行を出さない | 行を出さない | 秒だけも出さない |
| 連続する read / search | Exploring | Explored | `N files, N searches`。対象名は展開の中 |
| 連続する shell | Running | Ran | 1 件は先頭行の要約（80 字）。複数は `N commands` |
| 連続する edit | Editing | Edited | 1 件はファイル名。複数は `N files` と `+a -d` |
| 失敗 | 動詞はエラー形 | 同じ | 理由は折りたたみの外。`tool-reason` を残す |
| subagent | Working | Completed task | 名前。`durationMs` があるときだけ秒 |

行: 高さの最小 22px、font-size 14px、line-height 22px、padding `1px 0 1px 8px`、radius 4px。見出し内の gap は 4px。行と行の 6px は、前回のステップ間隔を維持する。chevron、動詞、詳細。hover 背景は前景 6%。12px はレビュー帯のラベルに使う。

展開の中は 12px、muted。ターミナル全文は出さない。最大高さ 8em、`overflow: auto`。ファイル diff の全文もここには出さない。

完了後の既定は閉じる。実行中のグループは開く。ユーザーが開閉した状態は、そのターンの id をキーに Webview 内だけ保持する。リロード後は既定に戻してよい。

思考本文は `Segment.text` が空白でなければそのまま出す。トリムして空ならヘッダーも出さない。`Planning next moves` は禁止。

## 5. Assistant Answer

`TurnModel.answer` を活動の下に置く。背景も枠も付けない。Markdown は既存レンダラー。

- 段落とリストの下マージン 8px
- 見出しは 13px、600、上 12px、下 4px
- コードブロックは角丸 8px、枠 `--agent-stroke`、コピーボタンは右上
- 回答の下から次のユーザーカードまで、ターン gap の 16px
- 途中の `text` で final でないものは活動の中の muted 行にする。final、または末尾テキストだけを answer にする（現行 `takeAnswer`）

## 6. File Review

Composer の直上。変更 0 なら DOM を出さない。

未受け入れ: `{N} ファイル`、`Undo`、`Keep`、右端 `Review`。ボタンは高さ 20px、角丸 4px、文字 12px。Review だけ塗りつぶす。

受け入れ後: Undo と Keep を外し、件数と Review を残す。変更 0 なら帯ごと出さない。

増減 `+a −d` は、この会話の帯には出ていなかった。帯の必須テキストにしない。ファイルを開いた diff には残す。

開き: ファイル名、`+a −d`、既存の diff / revert。インライン diff は 12 行で打ち切り、残りはエディタで開く。

## 7. Composer

DOM:

```html
<form class="composer">
  <ol class="queue"></ol>
  <textarea></textarea>
  <div class="composer-bar">
    <div class="composer-left">mode, model, attach</div>
    <div class="composer-right">send or stop</div>
  </div>
</form>
```

- 枠 1px `--agent-stroke-strong`、角丸 12px、背景 `--agent-fill`、padding `8px 10px 6px 10px`。角丸 20px は使わない
- textarea の最小高さは 1 行。最大は Webview の 30%。空ホームの入力 64px と、操作行 40px は、この会話 Composer の値ではない
- 操作行は高さ 28px、左右 end に分ける。モードは高さ 20px の pill、文字 12px
- Mode は Agent / Plan / Ask。ラベルは隠さない。300px でも文字を残す
- Model は 1 行 ellipsis。メニューはボタンの上に開く。幅はボタン以上、最大 280px
- 添付は capability が画像を拒否するとき disabled にし、理由を `title` に出す
- 送信は 24×24。実行中は停止。キューは入力の上、1 行 ellipsis、radius 4px
- 送信不能の理由はバーの下に 12px で 1 行

## 8. Plan / Approval / Subagent

Plan:

- ターン内のカード。角丸 12px、枠 `--agent-stroke`、padding 10px。Cursor のチャット内計画は枠が無く、本文は別エディタだった。Webview に第二エディタは作らない
- タイトル、overview 2 行、`View plan` で Markdown を開く、`Build`。ボタン高さは 24px。Build の Dark 琥珀色は採らず、テーマの主ボタンにする
- `canBuild` が false のとき Build は disabled。理由は `title` と accessible name
- Build は既存のローカル実行。クラウドへ切り替えない
- phase が building の間、Build は「停止」または disabled。既存の phase 名を使う

Approval:

- Composer の直上。対象のコマンドまたはパスを先に、ボタンを後に
- ボタンは許可、このセッションで許可、拒否。並びはこの順。主ボタンは許可
- Capability が承認を返さない経路ではカードを出さない
- タイムライン側は `Waiting · {要約}`。承認カードと二重に大きなターミナルを出さない

Subagent:

- 親ターンの活動行。状態は running / completed / error / cancelled / unknown
- `durationMs` が無い完了は秒を書かない
- `resultPreview` が空なら展開しても本文を作らない
- 既存のドックは、実行中の子がいるときだけ補助として残す。完了した子の正本はターン内

## 9. 状態

観測できたのは Idle の空 Agents Window だけ（A）。ほかはデータがあるときの表示規則（E、入力は既存 ViewModel）。

| 状態 | 表示 |
| --- | --- |
| Idle | ヘッダー、空スレッドまたは履歴、Composer |
| Streaming | 作業中。answer があればそこへ追記。停止ボタン |
| Thinking | 本文が来たときだけ Thinking 行を開く |
| Running tool | そのグループを開く。動詞は実行中形 |
| Tool completed | グループを閉じる。ヘッダーだけ |
| Tool failed | ヘッダーと、折りたたみの外に理由 |
| Waiting for approval | 活動は Waiting。承認カードを Composer 上に出す |
| Plan ready | View plan と Build。Build は canBuild 次第 |
| Build running | Plan の phase を表示。Composer は停止 |
| Completed | 作業時間、閉じた活動、地の回答、変更バー |
| Cancelled | 作業時間に中断。未完了ツールはエラー行 |
| Restored | 保存済みターンを Completed と同じ見た目。実行中だったものは unknown のまま秒を足さない |

## 10. データ

Backend の新規フィールドは要らない。

| 表示 | 入力 | 無いとき |
| --- | --- | --- |
| ユーザーカード | `TurnModel.user` | カードを出さない |
| 作業時間 | `startedAt` と `endedAt` | 行を出さない |
| 思考 | `Segment thinking.text` と `durationMs` | 本文が空なら行ごと出さない |
| Explored / Ran / Edited | `ToolRow.kind` と `status` | 動詞を推測で増やさない。`other` はツール名 |
| 増減 | `FileRow.additions/deletions` | 数値を隠す |
| 回答 | `answer` | 活動のみ |
| レビュー | `ViewChange` | バーを出さない |
| Plan | `ViewPlan` | カードを出さない |
| 承認 | `shell.permission` | カードを出さない |
| 子エージェント | `ViewSubagent` | 行を出さない |

`presentActivity` は read/search のまとめに加え、連続する shell と連続する edit も 1 グループにする。編集済みパスを explore から落とす既存処理は残す。

## 11. アクセシビリティ

- ユーザーカードは `article`。活動の開閉は `button` と `aria-expanded`
- 思考本文が無い行はボタンにしない
- 承認ボタンの名前は「許可、npm install」のように対象を含める
- アイコンだけのボタンは既存の visually hidden ラベルを残す
- 色だけで失敗を表さない。`失敗` または exit code を文字で出す
- 320% ズームで横スクロールが列の外に出ないこと。列は `min-width: 0`

## 12. 受入

- 300、390、600、1000 で、ユーザーカードが列幅 100% で左揃え
- 1000 では列が 640px を超えて中央
- 完了ターンの活動は 1 行。展開すると Explored / Ran / Edited がツール個別カードより先に見える
- 思考本文が空のフィクスチャで、Thinking の文章が出ない
- ターミナル出力が 8em を超えてスレッドを占有しない
- 変更 0 でレビューバーが無い
- Composer の操作行が 28px、送信が右端。枠は前景 20%、角丸 12px
- Plan の Build が canBuild false で押せない
- 承認の 3 ボタンが対象の下にあり、拒否が主ボタンではない
- Dark、Light、High Contrast で枠がテーマに追従する
- 既存の送信、停止、承認、Plan build、履歴オープンが同じ postMessage のまま動く
