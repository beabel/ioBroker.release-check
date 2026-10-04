![Logo](admin/release-check.png)
# ioBroker.release-check

[![NPM version](https://img.shields.io/npm/v/iobroker.release-check.svg)](https://www.npmjs.com/package/iobroker.release-check)
[![Downloads](https://img.shields.io/npm/dm/iobroker.release-check.svg)](https://www.npmjs.com/package/iobroker.release-check)
![Number of Installations](https://iobroker.live/badges/release-check-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/release-check-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.release-check.png?downloads=true)](https://nodei.co/npm/iobroker.release-check/)

**Tests:** ![Test and Release](https://github.com/beabel/ioBroker.release-check/workflows/Test%20and%20Release/badge.svg)

## ioBroker.release-check

Reports new versions of ioBroker adapters that you installed directly from [GitHub](https://github.com) and therefore do not receive update notices from the official ioBroker repository. The adapter only **reports**: it never installs or updates anything.

For every watched adapter it provides the installed and the latest version, the release notes and links to the release page and to the README of the new version, so you can read what changed before you update.

## Installation

Install the adapter from GitHub (custom URL in Admin, or `iobroker url beabel/ioBroker.release-check`), then create an instance.

## Configuration

| Option | Description |
|---|---|
| Detect adapters installed from GitHub automatically | Reads the installation source ioBroker stores for every adapter. Adapters installed from the official repository or npm are ignored. Default: on. |
| Also report pre-releases | Also treats tags such as `1.2.0-beta.1` as new versions. Default: off. |
| Check interval (minutes) | How often GitHub is asked for new versions. Minimum 60, maximum 1440, default 360. |
| Additional repositories | Repositories to watch in addition to the detected ones, as `owner/repo`. The adapter name is derived from the repository name (`ioBroker.name` becomes `name`). |

## Usage

Per watched adapter the adapter creates `adapters.<name>.*`:

| State | Description |
|---|---|
| `installedVersion` | Version installed on this system |
| `latestVersion` | Newest version found on GitHub |
| `updateAvailable` | `true` if the latest version is newer than the installed one |
| `releaseNotes` | Release notes as plain text (shortened to 1000 characters) |
| `releaseUrl` | Release page on GitHub |
| `readmeUrl` | README of the new version |
| `repository` | The GitHub repository |
| `lastCheck` | Time of the last successful check (epoch ms) |

`summary.updatesCount` and `summary.updateList` (JSON array with `adapter`, `installed`, `latest`, `releaseUrl`, `readmeUrl`) summarise all pending updates. Use them in a script to send a message with your favourite messenger adapter. A log line at `info` level is written once per new version.

## How it works

The adapter does **not** use the GitHub REST API, so it does not consume its rate limit. It reads the public `releases.atom` feed of each repository (falling back to `tags.atom` for repositories that only create tags) and sends the stored ETag with every request. If nothing changed, GitHub answers `304 Not Modified` without a body. Requests are sent one after the other with a pause in between.

Limitations:

* Only **public** repositories are supported.
* Only tags that look like versions (`1.2.3`, `v1.2.3`) are considered.
* The adapter cannot know about changes between releases (new commits on `main`).

## Support

* Questions and bug reports: [GitHub issues](https://github.com/beabel/ioBroker.release-check/issues)
* Discussions: [ioBroker forum](https://forum.iobroker.net)

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (Maik Ries) initial release: detects adapters installed from GitHub and reports new releases without using the GitHub API

## License
MIT License

Copyright (c) 2026 Maik Ries <iobroker@ne-xt.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.