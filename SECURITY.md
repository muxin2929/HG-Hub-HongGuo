# 安全说明

## 不要提交的内容

以下内容一律不要提交到仓库，也不要贴到公开 Issue：

- 服务器公网 IP、SSH 端口、面板地址、宝塔/1Panel 地址；
- 服务器账号、密码、私钥、`authorized_keys`、Cookie、Bearer Token；
- 真实域名对应的证书私钥、DNS API Token、CDN 密钥；
- APK 签名证书（`.jks` / `.keystore` / `.p12`）及密码；
- 含用户数据的 SQLite 数据库（`data/account.db`）、日志、缓存；
- `local.properties`、`web/.env.production`、`desktop/latest.yml` 等本地配置。

仓库的 `.gitignore` 已覆盖上述大部分文件。提交前仍建议执行一次敏感信息扫描：

```bash
git grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}|/root/|/www/server|ssh |scp |password|secret|api[_-]?key' -- .
```

## 公开源码与 Release 的区别

- 公开源码中的域名、包名、服务地址全部是占位符（`your-domain.example` / `your-upstream.example`），不包含作者的线上环境。
- 官方 Release 中的 APK / EXE 是按作者自用环境构建的安装包，二进制内会包含构建时写入的服务地址；这是分发客户端的正常现象。若你不希望公开自己的服务地址，请不要分发自己构建的安装包。
- Release 不包含服务器凭据、数据库、证书或用户数据。

## 报告问题

如果你发现仓库中有敏感信息泄露，或发现代码漏洞，请优先使用 GitHub 的 **Private vulnerability reporting / Security advisory** 功能，不要开公开 Issue。

如果发现仓库中误包含了你的版权内容或隐私信息，请通过仓库 Issue 说明具体文件路径，作者会尽快处理。
