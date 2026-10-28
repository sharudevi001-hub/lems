/*
 * LEMS ESP32 RFID + OLED + 3-button kiosk
 * Hardware: ESP32 DevKit, MFRC522, SSD1306 128x64 I2C, 3 push buttons.
 * Libraries (Arduino Library Manager): MFRC522, Adafruit SSD1306, Adafruit GFX.
 *
 * Default wiring:
 * MFRC522 SDA/SS=5, SCK=18, MOSI=23, MISO=19, RST=22, 3.3V and GND.
 * OLED SDA=21, SCL=22 (change RFID RST to 27 if sharing I2C pins).
 * Buttons to GND: GOOD=32, DAMAGED=33, MISSING_PARTS=25 (INPUT_PULLUP).
 * Set WIFI_SSID, WIFI_PASSWORD, API_BASE_URL and KIOSK_API_KEY in secrets.h.
 *
 * Security: use HTTPS and a unique KIOSK_API_KEY in production. Never commit secrets.h.
 * This firmware only reports the UID to the API; UID alone does not authorize checkout.
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "secrets.h"

#define RFID_SS 5
#define RFID_RST 27
#define BTN_GOOD 32
#define BTN_DAMAGED 33
#define BTN_MISSING 25
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

MFRC522 rfid(RFID_SS, RFID_RST);
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
String activeStudentId = "";
unsigned long lastButtonAt = 0;

void showMessage(const String &a, const String &b = "", const String &c = "") {
  display.clearDisplay(); display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1); display.setCursor(0, 0);
  display.println("LEMS KIOSK"); display.println("----------------");
  display.println(a); if (b.length()) display.println(b); if (c.length()) display.println(c);
  display.display();
}
String uidHex() {
  String value;
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) value += "0";
    value += String(rfid.uid.uidByte[i], HEX);
  }
  value.toUpperCase(); return value;
}
String postJson(const String &path, const String &payload) {
  if (WiFi.status() != WL_CONNECTED) return "";
  WiFiClientSecure client;
  client.setCACert(ROOT_CA_CERT); // Fail closed unless the server certificate chains to this CA.
  HTTPClient http;
  String url = String(API_BASE_URL) + path;
  if (!http.begin(client, url)) return "";
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Kiosk-Key", KIOSK_API_KEY);
  int code = http.POST(payload);
  String body = code > 0 ? http.getString() : "";
  http.end();
  if (code < 200 || code >= 300) return "";
  return body;
}
void setup() {
  Serial.begin(115200);
  pinMode(BTN_GOOD, INPUT_PULLUP); pinMode(BTN_DAMAGED, INPUT_PULLUP); pinMode(BTN_MISSING, INPUT_PULLUP);
  Wire.begin(21, 22);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { Serial.println("OLED init failed"); }
  showMessage("Starting Wi-Fi...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 15000) delay(250);
  SPI.begin(); rfid.PCD_Init();
  if (WiFi.status() == WL_CONNECTED) showMessage("Tap Student ID Card");
  else showMessage("Wi-Fi unavailable", "Restart to retry");
}
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect(); showMessage("Wi-Fi disconnected", "Reconnect pending"); delay(1000); return;
  }
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    showMessage("Reading RFID...", uidHex());
    String uid = uidHex();
    String payload = String("{\"uid\":\"") + uid + "\"}";
    showMessage("Verifying Student...");
    String result = postJson("/api/kiosk/verify-rfid", payload);
    if (result.length() && result.indexOf("\"valid\":true") >= 0) {
      activeStudentId = uid;
      showMessage("Student Verified", "Welcome, Student", "Continue in LEMS app");
    } else {
      activeStudentId = "";
      showMessage("Invalid Student Card", "Access Denied");
    }
    rfid.PICC_HaltA(); rfid.PCD_StopCrypto1(); delay(1800);
    if (activeStudentId.length()) showMessage("Return Condition", "1: Good  2: Damage", "3: Missing Parts");
    else showMessage("Tap Student ID Card");
  }
  if (activeStudentId.length() && millis() - lastButtonAt > 700) {
    String condition = "";
    if (digitalRead(BTN_GOOD) == LOW) condition = "GOOD";
    else if (digitalRead(BTN_DAMAGED) == LOW) condition = "DAMAGED";
    else if (digitalRead(BTN_MISSING) == LOW) condition = "MISSING_PARTS";
    if (condition.length()) {
      lastButtonAt = millis();
      showMessage("Sending feedback...", condition);
      String payload = String("{\"uid\":\"") + activeStudentId + "\",\"condition\":\"" + condition + "\"}";
      String result = postJson("/api/kiosk/return-condition", payload);
      if (result.length()) showMessage("Transaction Successful", condition);
      else showMessage("Feedback not saved", "No active return session");
      delay(1800); showMessage("Tap Student ID Card");
      activeStudentId = "";
    }
  }
  delay(30);
}
