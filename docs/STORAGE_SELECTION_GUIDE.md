# Cividge ストレージ選択・運用ガイド

このガイドは **Cividge の現在の保存・配信モデル**について説明します。料金・無料枠・アカウント要件は変わるため、数値をアプリの保証として固定しません。利用前に [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) と [Filebase pricing](https://filebase.com/pricing/) を確認してください。

## 1. まず区別するもの

| 概念 | Cividgeでの意味 |
| --- | --- |
| Object | 最終アップロードbytesの不変内容。`sha256:<digest>` がidentity |
| Link | `host:filename` の公開名。同じObjectへのLinkはすべてpeer |
| Placement | R2、Filebase、Kuboなどにある物理的な保持状態 |
| Public IPFS Gateway | CIDをHTTPで取得する経路。Placementでも保存保証でもない |

同じbytesがR2とFilebaseにあっても、Objectは一つでPlacementが複数あります。別名を作っても物理bytesを毎回複製するわけではありません。物理削除は一覧表示やKVの欠落から判断せず、ObjectLifecycleのrelease authorizationに従います。

## 2. R2 / Filebase / Kuboの選び方

| 選択 | 向いている場面 | 運用上の確認 |
| --- | --- | --- |
| Cloudflare R2 | S3型の直接uploadとWorkerからの配信を使う | bucket、S3 credential、browser CORS、WorkerのR2 bindingと同じbucket名を確認する。保存容量と操作回数の料金を監視する |
| Filebase IPFS bucket | CIDを持つIPFS Placementを利用する | IPFS保存と配信帯域を別々に監視する。CIDがあるだけではPin継続や永久配信の保証にならない |
| 自宅Kubo（任意） | 同じCIDの追加保全先を自分で持つ | ノード・ディスク・回線が稼働していることを監視する。Kubo RPCを公開インターネットへ露出しない |

Cloudflare R2はインターネット向けegress料金を設けていませんが、保存・操作などの課金条件があります。[公式料金表](https://developers.cloudflare.com/r2/pricing/)で現在の条件を確認してください。Filebaseでは**IPFS帯域は別の課金・制限対象**です。S3互換の非IPFS object storageのegress条件と混同しないでください。[Filebaseの帯域説明](https://filebase.com/docs/ipfs/bandwidth-usage)を確認してください。

KuboへPinしたからといって、公共Gatewayが必ずそのノードから取得し、Filebaseの転送量がゼロになるわけではありません。Gatewayは取得経路であり、Kubo Pinは保存状態です。重要な元ファイルにはCividgeの外にも独立したバックアップを残してください。

## 3. 容量解放と一覧

- **80 MB上限：** 1ファイルのglobal upload limitは80,000,000 bytesです。元ファイルと最終bytesの両方を検査します。大きな動画用アップローダとしては扱わないでください。
- **FIFO・手動削除：** いずれもObjectLifecycleへreleaseを要求する操作です。あるLinkを消してもpeer Linkが残れば、共有ObjectのPlacementをそれだけで解放しません。
- **Filebase RPC：** Worker経由のRPC Placementを物理unpinする場合は、Worker専用bucket/tokenと明示的な `FILEBASE_DEDICATED_BUCKET=true` が必要です。browser S3 Placementや外部Pinを同じownershipとして扱いません。
- **管理一覧：** All / R2 / Filebaseは同じbrowser-managed snapshotのfilterです。reload後は前回観測した一覧を表示しますが、現在の正本ではありません。明示Refreshで観測し直します。

## 4. 公開URLとキャッシュ

URLは `https://delivery-host/filename` です。`BOARD` は削除反応性、`PUBLISHED` は長めの公開edge cacheを明示的に選ぶ用途policyです。Placementが増えても `BOARD` が自動で `PUBLISHED` には変わりません。Link期限はどちらのcache TTLよりも優先します。

動画の `?preview=1` は親Linkのpreview表現であり、別Linkや別の公開ファイルではありません。配信ルールを設定する場合は、このqueryを元動画と同一のcache entryへ潰さないでください。詳しくは[セキュリティ・キャッシュ運用ガイド](SECURITY_AND_CACHE_RUNBOOK.md)を参照してください。
