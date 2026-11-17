export async function enhanceTraining(curriculum, employee, level) {
  const start = employee.inductedAt || employee.joiningDate;
  curriculum.generation = 'Skill-based reference library';
  curriculum.tests = [1, 2, 3].map(week => ({
    id: `${level.toLowerCase()}-test-${week}`, title: `${level} week ${week} assessment`, day: week * 7,
    dueDate: new Date(Date.parse(`${start}T00:00:00Z`) + ((['Beginner', 'Intermediate', 'Advanced'].indexOf(level) * 21) + week * 7) * 86400000).toISOString().slice(0, 10),
    status: 'Pending', score: null,
    questions: curriculum.skills.slice(0, 5).map((skill, index) => ({
      id: `${week}-${index}`, skill,
      question: `${skill}: ${['Before implementing a change, which approach provides the strongest evidence that requirements are met?', 'A production change fails a regression check. What should you do first?', 'Before handing over your completed work, what should you include?'][week - 1]}`,
      options: ['Proceed without recording evidence', 'Ask a colleague to mark the task complete', ['Define acceptance criteria, implement the change and test the result', 'Investigate the failed check, fix the cause and rerun validation', 'Implementation notes, test evidence, known limitations and a handover checklist'][week - 1], 'Skip validation to save time'],
      correctAnswer: 2
    }))
  }));
  // The endpoint contract is documented in WORKFLOW_AUDIT.md. No personal data is sent.
  if (process.env.TRAINING_AI_URL && process.env.TRAINING_AI_KEY) {
    try {
      const response = await fetch(process.env.TRAINING_AI_URL, {
        method: 'POST', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TRAINING_AI_KEY}` },
        body: JSON.stringify({ skills: curriculum.skills, level, role: employee.designation, weeks: 3, instruction: 'Return JSON {lessons:[{title,topic,text}],tests:[{questions:[{question,options:[four strings],correctAnswer:0..3}]}]}. Provide substantive skill-specific lessons and three weekly assessments. No HTML.' })
      });
      if (!response.ok) throw new Error(`AI provider returned ${response.status}`);
      const generated = await response.json();
      if (!Array.isArray(generated.lessons) || !generated.lessons.length || generated.tests?.length !== 3 || generated.tests.some(t => !t.questions?.length || t.questions.some(q => typeof q.question !== 'string' || q.options?.length !== 4 || !Number.isInteger(q.correctAnswer) || q.correctAnswer < 0 || q.correctAnswer > 3))) throw new Error('AI provider returned an invalid curriculum.');
      const escape = value => String(value).replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
      curriculum.pdfs = generated.lessons.map(lesson => ({ title: lesson.title, topic: lesson.topic, materialHtml: `<h1>${escape(lesson.title)}</h1><p>${escape(lesson.text)}</p>` }));
      curriculum.tests = curriculum.tests.map((test, i) => ({ ...test, questions: generated.tests[i].questions.map((q, index) => ({ ...q, id: `${i + 1}-${index}` })) }));
      curriculum.generation = 'AI generated';
    } catch (error) { curriculum.generation = 'Reference library (AI unavailable)'; curriculum.generationError = error.message; }
  }
  return curriculum;
}

export function gradeWeeklyTest(test, answers) {
  if (!test?.questions?.length) throw new Error('Assessment has no questions. Regenerate the training track.');
  const complete = test.questions.every(q => Number.isInteger(answers?.[q.id]) && answers[q.id] >= 0 && answers[q.id] < q.options.length);
  if (!complete) throw new Error('Answer every question before submitting.');
  return Math.round(test.questions.filter(q => answers[q.id] === q.correctAnswer).length / test.questions.length * 100);
}
