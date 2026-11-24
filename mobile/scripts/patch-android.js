// Lets Android hand "cooked://auth?..." links (from the Google sign-in page) back to the app.
const fs = require("fs");
const f = "android/app/src/main/AndroidManifest.xml";
let x = fs.readFileSync(f, "utf8");
if (!x.includes('android:scheme="cooked"')) {
  const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="cooked" android:host="auth" />
            </intent-filter>
`;
  const i = x.indexOf("</activity>");
  if (i < 0) throw new Error("MainActivity not found in AndroidManifest.xml");
  x = x.slice(0, i) + filter + "        " + x.slice(i);
  fs.writeFileSync(f, x);
}
console.log("deep link cooked://auth added");

// version numbers: always increasing, so Android accepts each new APK as an update
const b = parseInt(process.env.BUILD_NUMBER || "0", 10);
if (b > 0) {
  const g = "android/app/build.gradle";
  let s = fs.readFileSync(g, "utf8");
  s = s.replace(/versionCode\s+\d+/, `versionCode ${b}`).replace(/versionName\s+"[^"]*"/, `versionName "1.${b}"`);
  fs.writeFileSync(g, s);
  console.log(`versionCode ${b}`);
}
