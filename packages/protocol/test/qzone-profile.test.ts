import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import { parseQzoneProfile } from '../src/web/qzone_profile';

const profile = {
  spacename: '空间标题',
  desc: '空间说明',
  nickname: '空间昵称',
  signature: '空间签名',
  sex_type: 0,
  sex: '2',
  age_type: 0,
  age: 24,
  birthday_type: 0,
  birthday: '09-17',
  constellation_type: 0,
  constellation: 5,
  address_type: 0,
  country: '中国',
  province: '福建',
  city: '厦门',
  home_type: 0,
  hco: '中国',
  hp: '浙江',
  hc: '杭州',
  marriage: 4,
  bloodtype: 0,
  career: '研究员',
  company: '示例机构',
  cco: '中国',
  cp: '福建',
  cc: '厦门',
  cb: '示例地址',
};

function decode(data: Record<string, unknown>, own = false) {
  return parseQzoneProfile(JSON.stringify({ code: 0, data }), own);
}

test('个人档保留 QQ 空间可见资料和空间自身名称与说明', () => {
  deepEqual(decode(profile), {
    name: '空间标题',
    description: '空间说明',
    relationship: '恋爱中',
    personal: {
      nickname: '空间昵称',
      signature: '空间签名',
      gender: '女',
      age: 24,
      birthday: '9月17日',
      constellation: '处女座',
      region: '中国 福建 厦门',
      hometown: '中国 浙江 杭州',
      bloodType: '其他',
      occupation: '研究员',
      company: '示例机构',
      companyRegion: '中国 福建 厦门',
      companyAddress: '示例地址',
    },
  });
});

test('忽略接口附带的隐藏值，访客农历月日与主人公历值按各自语义读取', () => {
  const hidden = decode({
    ...profile,
    sex_type: 1,
    age_type: 2,
    birthday_type: 1,
    constellation_type: 1,
    address_type: 1,
    home_type: 1,
  });
  for (const key of ['gender', 'age', 'birthday', 'constellation', 'region', 'hometown'] as const) {
    equal(hidden.personal[key], undefined);
  }
  equal(decode({ ...profile, birthday: '08-15', islunar: 1 }).personal.birthday, '8月15日（农历）');
  equal(
    decode({ ...profile, birthyear: 2024, islunar: 1 }, true).personal.birthday,
    '八月15日（农历）',
  );
  equal(decode({ ...profile, birthday: '00-00' }).personal.birthday, undefined);
});
