# Signing the desktop builds

Unsigned builds work, but macOS Gatekeeper and Windows SmartScreen warn users on first launch. Signing switches on automatically once the secrets below exist (the `SIGNING` repository variable must be set to `on`).

## macOS (Developer ID + notarisation)
1. Join the Apple Developer Program. In Xcode or on developer.apple.com, create a **Developer ID Application** certificate.
2. Export it from Keychain Access as `.p12` with a password, then run `base64 -i cert.p12 | pbcopy`.
3. Create an app-specific password at appleid.apple.com.
4. Add these GitHub repository secrets:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID e-mail |
| `APPLE_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | 10-character team id |

## Windows (Authenticode)
Choose one:
- **Azure Trusted Signing** (cheapest; no hardware token). Create an account and a certificate profile, then add the secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`. Set `bundle.windows.signCommand` in `tauri.conf.json` to
  `trusted-signing-cli -e https://<region>.codesigning.azure.net -a <account> -c <profile> %1`.
- **OV/EV certificate as a .pfx:** add the secrets `WINDOWS_CERTIFICATE` (base64 pfx) and `WINDOWS_CERTIFICATE_PASSWORD`, plus `bundle.windows.certificateThumbprint`. Import the certificate in a workflow step before tauri-action (`Import-PfxCertificate`).

## Turn it on
Repository → Settings → Secrets and variables → Actions → **Variables** → add `SIGNING` = `on`. The `desktop.yml` workflow then passes the Apple secrets to tauri-action. Leave it unset to keep building unsigned.

## Check
- macOS: `spctl -a -vv /Applications/Floe.app` should print `accepted, source=Notarized Developer ID`.
- Windows: Explorer → right-click the installer → Properties → Digital Signatures.
