# Content Factory trigger — reference files only

Это шаблоны для **существующего** `/api/content-factory-scheduler/run`, по образцу
`deploy/social-scheduler`. Они не устанавливаются deploy workflow и не включены.
Не устанавливать второй таймер, если этот endpoint уже вызывается на KZ.

Порядок проверки существующего запуска, миграция, server opt-in, настройка источника,
ограничения HTML-копирования и ручная приёмка: [инструкция](../../docs/CONTENT_FACTORY_AUTOMATION.md).
Установка в `/etc/systemd/system` и включение допустимы только после отдельного
разрешения владельца. Никаких изменений Social scheduler или его таймера.
