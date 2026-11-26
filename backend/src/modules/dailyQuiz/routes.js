const Router = require('koa-router');
const crypto = require('node:crypto');
const { sequelize } = require('../../config/database');

const router = new Router();
const businessDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});
const keys = ['A', 'B', 'C', 'D'];

function readQuiz(date) {
  if (!process.env.DAILY_QUIZ_PILOT_QUESTIONS || process.env.DAILY_QUIZ_PILOT_DATE !== date) return null;
  const questions = JSON.parse(process.env.DAILY_QUIZ_PILOT_QUESTIONS);
  if (!Array.isArray(questions) || questions.length !== 5 ||
      questions.some(question => !question || typeof question.text !== 'string' || !question.text.trim() ||
        !Array.isArray(question.options) || question.options.length !== 4 ||
        question.options.some(option => typeof option !== 'string' || !option.trim()) ||
        new Set(question.options.map(option => option.trim())).size !== 4 ||
        !keys.includes(question.correct) || typeof question.explanation !== 'string' || !question.explanation.trim()) ||
      new Set(questions.map(question => question.text.trim())).size !== 5) {
    throw new Error('Invalid daily quiz pilot fixture');
  }
  const version = crypto.createHash('sha256').update(JSON.stringify(questions)).digest('hex');
  return { questions, version };
}

function readJson(value, fallback) {
  return typeof value === 'string' ? JSON.parse(value) : value ?? fallback;
}

async function handle(ctx) {
  const user = ctx.state.user;
  const parts = Object.fromEntries(businessDay.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const date = [parts.year, parts.month, parts.day].join('-');
  if (!process.env.DAILY_QUIZ_PILOT_STAFF_ID ||
      String(user.staffId) !== process.env.DAILY_QUIZ_PILOT_STAFF_ID) {
    ctx.body = { code: 0, data: { required: false } };
    return;
  }
  const quiz = readQuiz(date);
  if (!quiz) {
    ctx.body = { code: 0, data: { required: false } };
    return;
  }

  const identity = [user.staffId, date, quiz.version];
  const data = await sequelize.transaction(async transaction => {
    const query = (sql, replacements = identity) => sequelize.query(sql, { replacements, transaction });
    const where = 'WHERE staff_id = ? AND business_date = ? AND quiz_version = ?';
    if (ctx.method === 'POST') {
      const { version } = ctx.request.body || {};
      ctx.assert(version === quiz.version, 409, '今日题库已更新，请重新打开答题页');
      await query(
        'INSERT INTO daily_quiz_pilot_attempt (staff_id, business_date, quiz_version, store_id) VALUES (?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE staff_id = staff_id',
        [...identity, user.storeId ?? null]
      );
    }

    const [rows] = await query('SELECT * FROM daily_quiz_pilot_attempt ' + where +
      (ctx.method === 'POST' ? ' FOR UPDATE' : ''));
    const attempt = rows[0] || {};
    let firstAnswers = readJson(attempt.first_answers, null);
    let firstScore = attempt.first_score ?? null;
    let remaining = readJson(attempt.remaining_questions, quiz.questions.map((_, index) => index));
    const history = readJson(attempt.retry_history, []);

    if (ctx.method === 'POST') {
      const { answers, mode, requestId, questionIds } = ctx.request.body || {};
      ctx.assert(mode === 'first' || mode === 'retry', 400, '答题阶段无效');
      ctx.assert(typeof requestId === 'string' && /^[a-z0-9-]{1,80}$/i.test(requestId), 400, '提交编号无效');
      if (mode === 'first' && firstAnswers) {
        ctx.assert(JSON.stringify(firstAnswers) === JSON.stringify(answers), 409, '首次答案已保存');
      } else if (mode === 'retry' && history.some(round => round.requestId === requestId)) {
        const round = history.find(entry => entry.requestId === requestId);
        ctx.assert(JSON.stringify(round.answers) === JSON.stringify(answers), 409, '提交编号已使用');
      } else {
        ctx.assert(mode === 'first' ? !firstAnswers : firstAnswers && remaining.length, 409, '答题阶段已更新');
        ctx.assert(Array.isArray(answers) && answers.length === remaining.length &&
          answers.every(answer => keys.includes(answer)), 400, '请完成当前全部题目');
        ctx.assert(JSON.stringify(questionIds) === JSON.stringify(remaining), 409, '待答题目已更新');
        const wrong = remaining.filter((index, offset) => quiz.questions[index].correct !== answers[offset]);
        if (mode === 'first') {
          firstAnswers = answers;
          firstScore = (5 - wrong.length) * 20;
          await query(
            'UPDATE daily_quiz_pilot_attempt SET first_answers = ?, first_score = ?, first_submitted_at = UTC_TIMESTAMP() ' + where,
            [JSON.stringify(firstAnswers), firstScore, ...identity]
          );
        } else {
          history.push({ requestId, questions: remaining, answers });
        }
        remaining = wrong;
        await query(
          'UPDATE daily_quiz_pilot_attempt SET remaining_questions = ?, retry_history = ?, ' +
          'completed_at = IF(?, UTC_TIMESTAMP(), NULL) ' + where,
          [JSON.stringify(remaining), JSON.stringify(history), remaining.length === 0, ...identity]
        );
      }
    }

    const result = { required: remaining.length > 0, date, version: quiz.version, firstScore };
    if (ctx.path.endsWith('/today-status')) return result.required ? { required: true } : { required: false };
    result.questions = remaining.map(index => {
      const question = quiz.questions[index];
      return { index, text: question.text, options: question.options };
    });
    result.review = firstAnswers ? quiz.questions.flatMap((question, index) =>
      question.correct === firstAnswers[index] ? [] : [{
        index, text: question.text, selected: firstAnswers[index],
        correct: question.correct, explanation: question.explanation
      }]) : [];
    return result;
  });
  ctx.body = { code: 0, data };
}

router.get('/today-status', handle);
router.get('/today', handle);
router.post('/submit', handle);
module.exports = router;
