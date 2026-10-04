'use strict';

const { expect } = require('chai');
const {
    parseInstalledFrom,
    parseRepoInput,
    adapterNameFromRepo,
    parseAtom,
    htmlToText,
    compareVersions,
    pickLatest,
    clampInterval,
} = require('../lib/github');

describe('parseInstalledFrom', () => {
    it('recognises the usual GitHub shapes', () => {
        const expected = { owner: 'foo', repo: 'ioBroker.bar' };
        for (const value of [
            'https://github.com/foo/ioBroker.bar/tarball/main',
            'git+https://github.com/foo/ioBroker.bar.git#v1.0.0',
            'git+ssh://git@github.com/foo/ioBroker.bar.git',
            'github:foo/ioBroker.bar',
            'foo/ioBroker.bar#master',
            'foo/ioBroker.bar',
            'https://github.com/foo/ioBroker.bar',
        ]) {
            expect(parseInstalledFrom(value), value).to.deep.equal(expected);
        }
    });

    it('ignores npm and unrelated sources', () => {
        for (const value of [
            'iobroker.admin@7.0.0',
            'iobroker.admin',
            'https://example.com/a/b.tgz',
            '',
            undefined,
            5,
        ]) {
            expect(parseInstalledFrom(value), String(value)).to.equal(null);
        }
    });
});

describe('parseRepoInput / adapterNameFromRepo', () => {
    it('accepts owner/repo and URLs', () => {
        expect(parseRepoInput('foo/ioBroker.bar')).to.deep.equal({ owner: 'foo', repo: 'ioBroker.bar' });
        expect(parseRepoInput('https://github.com/foo/ioBroker.bar/')).to.deep.equal({
            owner: 'foo',
            repo: 'ioBroker.bar',
        });
        expect(parseRepoInput('nonsense')).to.equal(null);
    });

    it('derives the lower case adapter name', () => {
        expect(adapterNameFromRepo('ioBroker.Release-Check')).to.equal('release-check');
    });
});

describe('compareVersions / pickLatest', () => {
    it('orders versions and prereleases', () => {
        expect(compareVersions('v1.2.10', '1.2.9')).to.be.greaterThan(0);
        expect(compareVersions('1.0.0', '1.0.0-beta.1')).to.be.greaterThan(0);
        expect(compareVersions('1.0.0', 'v1.0.0')).to.equal(0);
        expect(compareVersions('2.0.0', '10.0.0')).to.be.lessThan(0);
    });

    it('returns NaN for non-version text', () => {
        expect(compareVersions('latest', '1.0.0')).to.be.NaN;
    });

    it('skips prereleases and non-version tags unless asked', () => {
        const entries = [{ tag: 'v2.0.0-beta.1' }, { tag: 'nightly' }, { tag: 'v1.5.0' }, { tag: 'v1.4.0' }];
        expect(pickLatest(entries, false).tag).to.equal('v1.5.0');
        expect(pickLatest(entries, true).tag).to.equal('v2.0.0-beta.1');
        expect(pickLatest([{ tag: 'nightly' }], true)).to.equal(null);
        expect(pickLatest([], false)).to.equal(null);
    });
});

describe('parseAtom', () => {
    const feed = `<?xml version="1.0"?><feed>
<entry><id>x</id><updated>2026-10-03T19:22:49Z</updated>
<link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v1.2.3"/>
<title>Release v1.2.3</title>
<content type="html">&lt;ul&gt;
&lt;li&gt;Fixed &amp;amp; improved&lt;/li&gt;
&lt;/ul&gt;</content></entry>
</feed>`;

    it('extracts tag, link and plain-text notes', () => {
        const [entry] = parseAtom(feed);
        expect(entry.tag).to.equal('v1.2.3');
        expect(entry.url).to.equal('https://github.com/o/r/releases/tag/v1.2.3');
        expect(entry.notes).to.equal('- Fixed & improved');
    });

    it('returns an empty list for empty or broken feeds', () => {
        expect(parseAtom('<feed></feed>')).to.deep.equal([]);
        expect(parseAtom('not xml at all')).to.deep.equal([]);
    });

    it('shortens very long notes', () => {
        expect(htmlToText('a'.repeat(5000)).length).to.equal(1000);
    });
});

describe('clampInterval', () => {
    it('keeps the interval between 60 and 1440 minutes', () => {
        expect(clampInterval(1)).to.equal(60);
        expect(clampInterval(999999)).to.equal(1440);
        expect(clampInterval('abc')).to.equal(360);
        expect(clampInterval(120)).to.equal(120);
    });
});
