#!/usr/bin/env python3
"""Puts one app's new build into Quine's AltStore source, and prints the source.

Quine's iPhone apps share one AltStore source (one URL for all of them).
Each app's CI calls this with the source as it is now (if any), its build
and its listing (the app's altstore.json); the app's entry is replaced,
every other app's is kept, so apps publish independently.

The format: https://faq.altstore.io/developers/make-a-source. The app's
privacy keys are read from the .ipa's Info.plist, since AltStore checks
that a source declares the permissions an app asks for.
"""

import argparse
import datetime
import hashlib
import json
import os
import plistlib
import sys
import zipfile

# The source itself: Quine's, not any one app's.
SOURCE = {
    "name": "Quine",
    "identifier": "com.quineglobal.altstore",
    "subtitle": "Quine's apps for iPhone",
    "description": "Apps from Quine, for iPhone and iPad, installed and updated through AltStore.",
    "website": "https://git.quineglobal.com",
    "tintColor": "3A78F2",
}

p = argparse.ArgumentParser()
p.add_argument("--existing", help="the source as published now (missing or empty: start fresh)")
p.add_argument("--listing", required=True, help="the app's altstore.json")
p.add_argument("--ipa", required=True)
p.add_argument("--version", required=True)
p.add_argument("--build", required=True)
p.add_argument("--download-url", required=True, help="where the .ipa will be")
p.add_argument("--icon-url", required=True)
p.add_argument("--source-url", required=True)
p.add_argument("--notes", default="")
a = p.parse_args()

with zipfile.ZipFile(a.ipa) as z:
    plist = next(n for n in z.namelist() if n.count("/") == 2 and n.endswith(".app/Info.plist"))
    info = plistlib.loads(z.read(plist))
with open(a.listing) as f:
    listing = json.load(f)
# AltStore's colors are hex without the '#'.
if "tintColor" in listing:
    listing["tintColor"] = listing["tintColor"].lstrip("#")
with open(a.ipa, "rb") as f:
    sha256 = hashlib.sha256(f.read()).hexdigest()
size = os.path.getsize(a.ipa)
date = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
notes = a.notes or f"Build {a.build}."
# Privacy: a list of {name, usageDescription}, name without NS…UsageDescription
# (NSCameraUsageDescription → Camera), as AltStore's own source has it.
privacy = [
    {"name": k[len("NS"):-len("UsageDescription")], "usageDescription": v}
    for k, v in sorted(info.items())
    if k.startswith("NS") and k.endswith("UsageDescription")
]

app = {
    **listing,
    "bundleIdentifier": info["CFBundleIdentifier"],
    "iconURL": a.icon_url,
    "screenshots": listing.get("screenshots", []),
    "versions": [
        {
            "version": a.version,
            "buildVersion": a.build,
            "date": date,
            "localizedDescription": notes,
            "downloadURL": a.download_url,
            "size": size,
            "sha256": sha256,
            "minOSVersion": info.get("MinimumOSVersion", "15.1"),
        }
    ],
    # The latest version again, for AltStore before sources had `versions`.
    "version": a.version,
    "versionDate": date,
    "versionDescription": notes,
    "downloadURL": a.download_url,
    "size": size,
    "appPermissions": {"entitlements": [], "privacy": privacy},
}

apps = []
if a.existing and os.path.exists(a.existing) and os.path.getsize(a.existing):
    try:
        with open(a.existing) as f:
            old = json.load(f)
        # Only another app's entries survive, and only from our own source.
        if old.get("identifier") == SOURCE["identifier"]:
            apps = [x for x in old.get("apps", []) if x.get("bundleIdentifier") != app["bundleIdentifier"]]
    except (ValueError, OSError) as e:
        print(f"ignoring the existing source: {e}", file=sys.stderr)
apps.append(app)
apps.sort(key=lambda x: x["name"].lower())

json.dump({**SOURCE, "sourceURL": a.source_url, "apps": apps, "news": []}, sys.stdout, indent=2)
print()
