# ساخت APK برای اندروید

## پیش‌نیازها

- Android Studio (دانلود از developer.android.com/studio)
- Java JDK 17+

## روش ۱: Android Studio (ساده‌ترین روش)

1. پوشه `android/` را در Android Studio باز کنید
2. منتظر sync شدن Gradle بمانید
3. از منو: `Build → Generate Signed Bundle / APK`
4. گزینه **APK** را انتخاب کنید
5. فایل Keystore موجود را انتخاب کنید:
   - Keystore path: `android/crm-taranom.jks`
   - Store password: `CrmTaranom2024!`
   - Key alias: `crm-taranom`
   - Key password: `CrmTaranom2024!`
6. Release → Finish
7. APK در `app/release/app-release.apk` ساخته می‌شود

## روش ۲: Command Line (بدون Android Studio)

```bash
# نصب Android SDK از https://developer.android.com/tools/sdkmanager
export ANDROID_HOME=/path/to/android-sdk
cd android
./gradlew assembleRelease
# APK: app/build/outputs/apk/release/app-release.apk
```

## روش ۳: PWABuilder (آسان‌ترین - آنلاین)

1. به https://www.pwabuilder.com بروید
2. آدرس سرور CRM (`http://45.90.98.99:3000`) را وارد کنید
3. دکمه `Package for stores` را بزنید
4. گزینه Android را انتخاب کنید
5. Keystore موجود را آپلود کنید (crm-taranom.jks)
6. APK دریافت کنید

## اطلاعات Keystore

| مشخصه | مقدار |
|-------|-------|
| فایل | `android/crm-taranom.jks` |
| Store Password | `CrmTaranom2024!` |
| Key Alias | `crm-taranom` |
| Key Password | `CrmTaranom2024!` |
| SHA-256 | `06:7B:BD:8E:AA:0E:3D:6F:26:CB:8F:ED:CB:FD:9E:D3:97:EE:46:91:90:C4:3C:CD:25:DB:4D:74:64:54:99:69` |

## نکات مهم

- فایل `assetlinks.json` در مسیر `/.well-known/assetlinks.json` روی سرور قرار دارد
- این فایل برای TWA (Trusted Web Activity) الزامی است
- اپلیکیشن از Chrome برای رندر استفاده می‌کند (نه WebView ساده)
- اگر Chrome نصب نباشد، WebView Fallback فعال می‌شود
- Package ID: `ir.taranom.crm`
