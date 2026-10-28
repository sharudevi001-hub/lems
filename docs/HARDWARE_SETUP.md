# LEMS Hardware Setup

## Wiring (ESP32 DevKit)

| Module | ESP32 pin |
|---|---|
| MFRC522 SDA/SS | GPIO 5 |
| MFRC522 SCK / MOSI / MISO | GPIO 18 / 23 / 19 |
| MFRC522 RST | GPIO 27 |
| SSD1306 SDA / SCL | GPIO 21 / 22 |
| Good condition button | GPIO 32 to GND |
| Damaged button | GPIO 33 to GND |
| Missing parts button | GPIO 25 to GND |
| MFRC522 power | 3.3V only |
| All module grounds | GND |

Do not power MFRC522 from 5V. OLED I2C address is usually 0x3C. Use momentary pushbuttons; firmware enables internal pull-ups.

## Firmware setup

1. Install Arduino IDE 2.x and select ESP32 Dev Module.
2. Install libraries: MFRC522, Adafruit SSD1306, Adafruit GFX.
3. Copy `firmware/esp32-kiosk/secrets.example.h` to `secrets.h` and set Wi-Fi, HTTPS API URL, and kiosk key. Do not commit `secrets.h`.
4. Open `firmware/esp32-kiosk/lems_kiosk.ino`, select the board/COM port and upload.
5. Confirm OLED says `Tap Student ID Card`; tap a linked card and check the serial monitor/OLED.

## Security and hardware status

The firmware sends UID and condition data over Wi-Fi. The backend must validate the UID against an active account and only accept condition reports tied to an active return session. Before public deployment, replace the temporary TLS bypass in the example with certificate validation. Do not connect a relay/solenoid until the kiosk authorization workflow is tested; the lock is intentionally optional.
