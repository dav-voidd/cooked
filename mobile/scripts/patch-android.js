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
