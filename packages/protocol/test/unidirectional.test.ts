import assert from 'node:assert/strict';
import test from 'node:test';
import { encode } from '../src/protobuf';
import { GetUnidirectionalFriendList } from '../src/oidb/friend/unidirectional';

function response(json: unknown): Record<string, unknown> {
  return {
    jsonBody: typeof json === 'string' ? json : JSON.stringify(json),
  };
}

test('0xe17 请求：raw command + {2:0, 3:JSON}', () => {
  assert.equal(GetUnidirectionalFriendList.cmd, 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0');
  const body = GetUnidirectionalFriendList.serialize({ uin: '10001' });
  assert.deepEqual(JSON.parse(body.jsonBody as string), {
    uint64_uin: '10001',
    uint64_top: 0,
    uint32_req_num: 99,
    bytes_cookies: '',
  });
  assert.equal(body.subCommand, 0);
});

test('0xe17 响应：透传 rpt_block_list', () => {
  const list = [{ uint64_uin: '20002', extra: { keep: true } }];
  const entries = GetUnidirectionalFriendList.deserialize(
    response({ ActionStatus: 'OK', ErrorCode: 0, rpt_block_list: list }),
  );
  assert.deepEqual(entries, list);
});

test('0xe17 业务失败 / 坏 JSON / 缺列表都报错', () => {
  assert.throws(
    () =>
      GetUnidirectionalFriendList.deserialize(
        response({ ActionStatus: 'FAIL', ErrorCode: 302, ErrorInfo: 'parse json failed' }),
      ),
    /302 parse json failed/,
  );
  assert.throws(() => GetUnidirectionalFriendList.deserialize(response('{')), /JSON/);
  assert.throws(
    () => GetUnidirectionalFriendList.deserialize(response({ ActionStatus: 'OK', ErrorCode: 0 })),
    /rpt_block_list/,
  );
  assert.throws(
    () => GetUnidirectionalFriendList.deserialize({ errorCode: 5, errorMessage: 'denied' }),
    /denied/,
  );
});

test('0xe17 请求编码仍是合法 protobuf', () => {
  const bytes = encode(
    GetUnidirectionalFriendList.reqSchema,
    GetUnidirectionalFriendList.serialize({ uin: '10001' }),
  );
  assert.ok(bytes.length > 10);
});
