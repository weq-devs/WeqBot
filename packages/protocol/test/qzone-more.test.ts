import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { isQzonePageRequest } from '../src/web/qzone-pagination';
import { parseQzoneGuestbook, parseQzoneVideos, parseQzoneVisitors } from '../src/web/qzone_more';
import { parseQzoneShareComments, parseQzoneShares } from '../src/web/qzone_share';

const callback = (data: unknown) => `_Callback(${JSON.stringify({ code: 0, subcode: 0, data })});`;

const sharePage = `
<ul id="shares"><li id="share_10001_1700000000">
  <div class="_share_desc_cont"><span class="c_tx2"><script>doNotExecute()</script></span></div>
  <div class="mod_details"><img src="//a.qpic.cn/cover"><a class="_share_title"
    href="mqqapi://microapp/open?fakeUrl=https%3A%2F%2Fexample.org%2Foriginal">甲 &amp; 乙</a></div>
  <div class="mod_scraps"><span class="mgrl">2023-11-15 06:13</span></div>
  <script>shareInfos.push({id: 1700000000, type: 4, memo: '附言\\x0a第二行'});</script>
</li></ul>
<a href="cgi_qzsharegetmylistbytype?uin=10001&amp;page=2">下一页</a>`;

test('从分享页读取字面量附言、原链接、封面和时间，仅接受请求的空间和续页', () => {
  deepEqual(parseQzoneShares(sharePage, '10001', 1), {
    items: [
      {
        id: '1700000000',
        category: 4,
        memo: '附言\n第二行',
        title: '甲 & 乙',
        originalUrl: 'https://example.org/original',
        previewUrl: 'https://a.qpic.cn/cover',
        publishedAt: '2023-11-15 06:13',
        publishedTime: 1700000000,
      },
    ],
    next: 2,
  });
  equal(
    parseQzoneShares(sharePage.replace('06:13', '07:13'), '10001', 1).items[0]?.publishedTime,
    null,
  );
  deepEqual(parseQzoneShares('<form id="shareForm"></form><p>0条分享</p>', '10001', 1), {
    items: [],
    next: null,
  });
  const last = `${sharePage}<script>var totalPage = 1; var currentPage = 1;</script>`;
  equal(parseQzoneShares(last, '10001', 1).next, null);
  throws(() => parseQzoneShares(last, '10001', 2), /返回页与请求不匹配/);
  throws(() => parseQzoneShares(sharePage, '10002', 1), /主人或编号/);
  throws(() => parseQzoneShares('<p>请登录</p>', '10001', 1), /未返回/);
});

test('分享评论用服务端总数和每页请求数量推进，允许第一页多返回相邻评论', () => {
  const comment = (id: number) => ({
    CommentID: id,
    AuthorUin: 10001,
    Author: '甲',
    Content: '好 &amp; <br>第二行',
    Time: '11月15日 06:13',
  });
  const first = parseQzoneShareComments(
    callback({
      total: 5,
      items: [comment(1), comment(2), comment(3), { ...comment(4), items2: [comment(6)] }],
    }),
    1,
  );
  const second = parseQzoneShareComments(
    callback({ total: 5, items: [comment(4), comment(5)] }),
    2,
  );
  equal(first.next, 2);
  equal(first.items[0]?.text, '好 & \n第二行');
  equal(first.items[3]?.replies[0]?.id, '6');
  equal(second.next, null);
  equal(second.items[1]?.id, '5');
  deepEqual(parseQzoneShareComments(callback({ total: 0 }), 1), {
    items: [],
    total: 0,
    next: null,
  });
  throws(() => parseQzoneShareComments(callback({ total: 2, items: [] }), 1), /暂未返回/);
});

test('空间访客区分零记录、权限拒绝和参数失败，使用实际分页及总览数', () => {
  const list = {
    items: [{ uin: 10003, name: '访客', time: 1700000000 }],
    totalcount: 30,
    todaycount: 1,
  };
  equal(parseQzoneVisitors(callback(list), 1).next, null);
  const page = parseQzoneVisitors(
    callback({
      ...list,
      totalpage: 2,
      modvisitcount: [
        { mod: 5, totalcount: 1 },
        { mod: 0, totalcount: 57, todaycount: 2 },
      ],
    }),
    1,
  );
  equal(page.next, 2);
  equal(page.totalCount, 57);
  equal(page.todayCount, 2);
  equal(parseQzoneVisitors(callback({ ...list, items: [] }), 1).status, 'ok');
  equal(parseQzoneVisitors(callback({ totalcount: 30 }), 1).status, 'unavailable');
  equal(
    parseQzoneVisitors(
      '_Callback({code:-99996,subcode:-4009,message:"抱歉，您没有权限访问。"});',
      1,
    ).status,
    'forbidden',
  );
  throws(
    () => parseQzoneVisitors('_Callback({code:-99996,subcode:-4003,message:"参数错误"});', 1),
    /失败/,
  );
});

test('留言板保留寄语、回复和续页，忽略上游附带的审核字段', () => {
  const raw = callback({
    total: 2,
    authorInfo: { htmlMsg: '<p>欢迎</p>' },
    auditON: true,
    auditNum: 0,
    commentList: [
      {
        id: '81',
        uin: 10002,
        nickname: '留言者',
        htmlContent: '你好<br><img src="/qzone/em/e100.gif"><script>unwanted()</script>',
        replyList: [{ uin: 10001, nick: '主人', time: 123, content: '谢谢' }],
      },
    ],
  });
  const page = parseQzoneGuestbook(raw, 0);
  equal(page.total, 2);
  equal(page.greeting, '欢迎');
  equal(page.items[0]?.text, '你好\n[em]e100[/em]');
  equal(page.items[0]?.replies[0]?.text, '谢谢');
  equal(page.next, 1);
  equal(Object.hasOwn(page, 'audit'), false);
  equal(parseQzoneGuestbook(raw, 1).next, null);
});

test('独立视频按 vid 去重，拒绝无进展游标，播放地址与封面分开', () => {
  const row = {
    vid: 'fixture-vid',
    url: '//photovideo.photo.qq.com/play',
    pre: '//a.qpic.cn/cover',
  };
  const page = parseQzoneVideos(
    callback({
      Videos: [row, { ...row, url: `${row.url}?key=another` }],
      isLast: 'false',
      nextPageStart: 20,
    }),
    0,
  );
  equal(page.items.length, 1);
  equal(page.items[0]?.videoId, 'fixture-vid');
  equal(page.items[0]?.videoUrl, 'https://photovideo.photo.qq.com/play');
  equal(page.next, 20);
  throws(
    () => parseQzoneVideos(callback({ Videos: [row], isLast: 'false', nextPageStart: 20 }), 20),
    /未推进/,
  );
  equal(parseQzoneVideos(callback({ Videos: [], isLast: 'true' }), 20).next, null);
});

test('分享网关和其余新增列表共用空间翻页配额，原统计请求仍可独立读', () => {
  equal(
    isQzonePageRequest(
      'https://user.qzone.qq.com/p/h5/pc/api/sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshareget_comment?commpage=1',
    ),
    true,
  );
  equal(
    isQzonePageRequest(
      'https://h5.qzone.qq.com/proxy/domain/g.qzone.qq.com/cgi-bin/friendshow/cgi_get_visitor_simple?mask=1',
    ),
    false,
  );
  equal(
    isQzonePageRequest(
      'https://h5.qzone.qq.com/proxy/domain/g.qzone.qq.com/cgi-bin/friendshow/cgi_get_visitor_simple?mask=2&page=1',
    ),
    true,
  );
  equal(
    isQzonePageRequest(
      'https://h5.qzone.qq.com/proxy/domain/m.qzone.qq.com/cgi-bin/new/get_msgb?start=0',
    ),
    true,
  );
});
