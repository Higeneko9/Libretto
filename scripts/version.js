// Bumps the version: MAJOR.YY.MMDD.BUILD (BUILD counts up within a day, restarts at 0 on a new day).
//   node scripts/version.js            bump for today
//   node scripts/version.js --major 1  also change the major number
// VERSION is the source of truth (window title). The installer needs a 3-part semver, so
// desktop/package.json gets MAJOR.YY.<MMDD without leading zero>, and the full version as buildVersion.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const versionFile = path.join(root, "VERSION");
const packageFile = path.join(root, "desktop", "package.json");

const [major0, year0, day0, build0] = fs.readFileSync(versionFile, "utf8").trim().split(".");
const args = process.argv.slice(2);
const majorArg = args.indexOf("--major");
const major = majorArg >= 0 ? args[majorArg + 1] : major0;
if (!/^\d+$/.test(major)) throw new Error("--major needs a number");

const now = new Date();
const yy = String(now.getFullYear() % 100).padStart(2, "0");
const mmdd = String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
const sameDay = year0 === yy && day0 === mmdd;
const build = sameDay ? Number(build0) + 1 : 0;
const version = `${major}.${yy}.${mmdd}.${build}`;

fs.writeFileSync(versionFile, version + "\n");
const text = fs.readFileSync(packageFile, "utf8");
const semver = `${major}.${Number(yy)}.${Number(mmdd)}`;
fs.writeFileSync(packageFile, text.replace(/"version": "[^"]*"/, `"version": "${semver}"`).replace(/"buildVersion": "[^"]*"/, `"buildVersion": "${version}"`));
console.log(version);
