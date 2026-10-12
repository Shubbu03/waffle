# waffle

Follow Solana wallets, review scored PumpSwap buys, and copy trades on Android. Try simulated paper trades or approve real trades with your connected wallet.

Built with Expo, React Native, Bun, Hono, and PostgreSQL.

[![Download APK](https://img.shields.io/badge/Download-Android_APK-9bea72?logo=android&logoColor=black)](https://github.com/Shubbu03/waffle/releases/download/v1.0.0/waffle-v1.0.0.apk)

## Android releases

App versions live in `apps/mobile/app.json`:

- `expo.version`: the version users see, currently `1.0.0`. Use `1.0.1` for a fix, `1.1.0` for a feature release, and `2.0.0` for a major release.
- `expo.android.versionCode`: the Android build number, currently `1`. Increase it for each new release (`2`, `3`, ...), including rebuilds published under the same visible version.

Local Gradle builds read both values from this file. Settings displays the bundled app version. Reuse the same release signing key for updates.

Build the release APK using your configured Android SDK and JDK 17:

```sh
cd apps/mobile/android
NODE_ENV=production ./gradlew :app:assembleRelease --no-daemon --max-workers=2 --no-parallel
```

After testing the APK, copy `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` to a versioned filename (for example, `waffle-v1.0.0.apk`). On GitHub, open **Releases → Draft a new release**, choose the matching tag (for example, `v1.0.0`) on the commit used for the build, attach the APK, and publish it as the latest release.

After publishing, update the APK links in `README.md` and `apps/web/src/lib/site.ts` to the uploaded asset's direct download URL. The filename in each link must exactly match the uploaded filename. The current v1.0.0 asset is `waffle-v1.0.0.apk`. Renaming the file does not change its internal version, package name, or signing certificate. A public repository allows anyone to download it.

## Setup

Requires Bun 1.3.13, PostgreSQL, Android development tools, and an MWA-compatible Solana wallet. Wallet sign-in requires a native Android build.

```sh
bun install --frozen-lockfile

cp apps/api/.env.example apps/api/.env
cp apps/watcher/.env.example apps/watcher/.env
cp apps/mobile/.env.example apps/mobile/.env
cp packages/db/.env.example packages/db/.env
```

Fill in the database and provider settings described in each environment example. Use separate restricted API/watcher database logins; keep the migration-owner connection in `packages/db/.env`.

Set the mobile API URL and app identity URL. The API's `AUTH_URI` must match `EXPO_PUBLIC_WAFFLE_APP_URI`. For push notifications, configure Firebase and add `apps/mobile/google-services.json`.

```sh
bun run db:migrate
```

## Run

Run each app in a separate terminal:

```sh
bun run dev:api
bun run dev:watcher
bun run --filter '@waffle/mobile' android
```

The product website lives in `apps/web`. Run `bun run dev:web` for local development and `bun run build:web` to generate the static site in `apps/web/dist`.

## Checks

```sh
bun run lint
bun run typecheck
bun run test
```

Deploy a single API instance while prepared order state remains process-local.
