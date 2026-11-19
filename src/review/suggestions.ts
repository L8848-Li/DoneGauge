import type { Candidate } from './discovery.js';

const stopwords = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'with',
  'should',
  'must',
  'test',
  'tests',
  'user',
  'when',
  'can',
  '的',
  '要',
  '用户',
  '可以',
  '应该',
  '必须',
]);
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const terms: Record<string, string> = {
  邮箱: 'email',
  邮件: 'email',
  注册: 'registration',
  重复: 'duplicate',
  登录: 'login',
  密码: 'password',
  价格: 'price',
  负数: 'negative',
  精确: 'exact',
  总价: 'total',
  拒绝: 'reject',
  保存: 'store',
  创建: 'create',
  删除: 'delete',
  失败: 'fail',
  成功: 'success',
  超时: 'timeout',
  取消: 'cancel',
  文件: 'file',
  上传: 'upload',
  下载: 'download',
};

function tokens(text: string) {
  const result = new Set<string>();
  for (const { segment, isWordLike } of segmenter.segment(
    text.toLowerCase().replaceAll('_', ' '),
  )) {
    if (isWordLike && !stopwords.has(segment)) result.add(segment);
  }
  for (const [word, english] of Object.entries(terms))
    if (text.includes(word)) result.add(english);
  return result;
}

export function suggestTests(description: string, candidates: Candidate[]) {
  const required = tokens(description);
  return candidates
    .map((candidate) => {
      const shared = [...tokens(candidate.name)].filter((word) =>
        required.has(word),
      );
      return {
        id: candidate.id,
        file: candidate.file,
        name: candidate.name,
        shared,
      };
    })
    .filter((item) => item.shared.length)
    .sort((left, right) => right.shared.length - left.shared.length)
    .slice(0, 3);
}
