# pey.speech

[![AI](https://img.shields.io/badge/Built%20with-AI-blueviolet)](#)
[![version](https://img.shields.io/badge/version-1.2.0-blue.svg)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Bonyan Architecture](https://img.shields.io/badge/bonyan-0.11-56c3bf)](https://github.com/barnevis/bonyan)

## هدف

افزونه‌ی پلتفرمی از زیست‌بوم پی برای تشخیص گفتار دستگاه از مسیر آداپتور محیط قابل‌تعویض (Web Speech API در مرورگر ساده، تشخیص‌دهندهٔ دستگاه در اندروید از طریق پل Capacitor — آداپتور پیش‌فرض shipped بسته به محیط درست را برمی‌گزیند). بررسی پشتیبانی، مجوز میکروفن و نشست‌های شنود با تحویل متن‌های ناقص و نهایی؛ هیچ چیزی تفسیر نمی‌کند.

## ساختار

- `adapters/` — آداپتورهای محیط.
- `docs/` — سندهای پروژه.
- `lib/` — منطق سرویس.
- `tests/` — آزمون‌های افزونه.
- `index.js` — نقطه‌ی ورود.
- `manifest.json` — قرارداد افزونه.

## وابستگی‌ها

- **الزامی:** ندارد.
- **اختیاری:** ندارد.

## نصب و استفاده

افزونه با `manifest.json` و بستهٔ npm به برنامه‌ی میزبان افزوده می‌شود و پس از دو فاز آماده‌سازی و فعال‌سازی، سرویس `pey.speech.service` را عرضه می‌کند. میزبان با `getSupport` پشتیبانی محیط را می‌سنجد، با `requestPermission` مجوز می‌گیرد و با `listen` نشست شنود را با دو دستیار متن ناقص و نهایی باز می‌کند؛ آداپتور محیط و زبان پیش‌فرض با کلیدهای `adapter`، `adapterConfig` و `language` تنظیم می‌شوند.

## مجوز

این پروژه با مجوز MIT منتشر شده است؛ متن کامل در [LICENSE](LICENSE).

## سندهای مرتبط

- [معرفی](docs/introduction.md) — شناخت افزونه به زبان ساده.
- [مرجع](docs/reference.md) — API، رویدادها، خطاها و پیکربندی.
- [نیازمندی‌ها](docs/requirements.md) — سند ساخت افزونه، مکتوب پیش از پیاده‌سازی.
