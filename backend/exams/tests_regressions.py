from datetime import timedelta
from decimal import Decimal
import uuid

from django.contrib.auth import get_user_model
from django.test import override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from exams.models import Answer, Exam, ExamAttempt, ExamTimeExtension, Question, Result

User = get_user_model()


@override_settings(SECURE_SSL_REDIRECT=False)
class ExamsRegressionTests(APITestCase):
    def setUp(self):
        now = timezone.now()
        self.staff = User.objects.create_user(
            email='staff-reg@example.com',
            username='staff_reg',
            name='Staff Reg',
            password='Password123',
            role='staff',
        )
        self.student = User.objects.create_user(
            email='student-reg@example.com',
            username='student_reg',
            name='Student Reg',
            password='Password123',
            role='student',
            department='CS',
        )
        self.exam = Exam.objects.create(
            title='Regression Exam',
            description='Regression exam',
            exam_type='mixed',
            start_time=now - timedelta(minutes=30),
            end_time=now + timedelta(minutes=20),
            duration=60,
            total_marks=Decimal('100'),
            passing_marks=Decimal('40'),
            is_published=True,
            created_by=self.staff,
        )
        self.question = Question.objects.create(
            exam=self.exam,
            type='coding',
            text='Write hello world',
            points=Decimal('10'),
            order=1,
        )

    def test_start_exam_returns_attempt_id_and_attemptId(self):
        self.client.force_authenticate(user=self.student)
        response = self.client.post(f'/api/v1/exams/{self.exam.id}/attempt/')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertIn('attempt_id', response.data)
        self.assertIn('attemptId', response.data)

    def test_start_exam_returns_409_when_already_submitted(self):
        ExamAttempt.objects.create(
            exam=self.exam,
            student=self.student,
            start_time=timezone.now() - timedelta(minutes=15),
            submit_time=timezone.now() - timedelta(minutes=5),
            status='submitted',
        )

        self.client.force_authenticate(user=self.student)
        response = self.client.post(f'/api/v1/exams/{self.exam.id}/attempt/')

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)

    def test_save_answer_handles_null_answer_without_integrity_error(self):
        attempt = ExamAttempt.objects.create(
            exam=self.exam,
            student=self.student,
            start_time=timezone.now() - timedelta(minutes=5),
            status='in_progress',
        )
        answer = Answer.objects.create(
            attempt=attempt,
            question=self.question,
            answer={},
        )

        self.client.force_authenticate(user=self.student)
        payload = {
            'attempt_id': str(attempt.id),
            'answers': [
                {
                    'question_id': str(self.question.id),
                    'answer': None,
                    'code': 'print("hello")',
                }
            ],
        }
        response = self.client.post(
            f'/api/v1/exams/{self.exam.id}/attempt/save/',
            payload,
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        answer.refresh_from_db()
        self.assertEqual(answer.answer, {})
        self.assertEqual(answer.code, 'print("hello")')

    def test_bulk_results_invalid_exam_returns_404(self):
        self.client.force_authenticate(user=self.staff)
        response = self.client.get(f'/api/v1/staff/exams/{uuid.uuid4()}/bulk-results/')

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_exam_statistics_pass_percentage_uses_results_denominator(self):
        student_two = User.objects.create_user(
            email='student2-reg@example.com',
            username='student2_reg',
            name='Student Two',
            password='Password123',
            role='student',
        )

        attempt_submitted = ExamAttempt.objects.create(
            exam=self.exam,
            student=self.student,
            start_time=timezone.now() - timedelta(minutes=25),
            submit_time=timezone.now() - timedelta(minutes=10),
            status='submitted',
            total_score=Decimal('100'),
            obtained_score=Decimal('80'),
        )
        Result.objects.create(
            attempt=attempt_submitted,
            exam=self.exam,
            student=self.student,
            total_marks=Decimal('100'),
            obtained_marks=Decimal('80'),
            percentage=Decimal('80'),
            status='pass',
            grading_status='fully_graded',
            submitted_at=timezone.now() - timedelta(minutes=10),
        )

        ExamAttempt.objects.create(
            exam=self.exam,
            student=student_two,
            start_time=timezone.now() - timedelta(minutes=10),
            status='in_progress',
        )

        self.client.force_authenticate(user=self.staff)
        response = self.client.get(f'/api/v1/staff/exams/{self.exam.id}/statistics/')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['totalAttempts'], 2)
        self.assertEqual(response.data['passPercentage'], 100.0)

    def test_time_extension_is_applied_on_start(self):
        ExamTimeExtension.objects.create(
            exam=self.exam,
            student=self.student,
            additional_minutes=20,
            reason='Accessibility',
            approved_by=self.staff,
            approved_at=timezone.now(),
        )

        baseline_remaining = int((self.exam.end_time - timezone.now()).total_seconds())

        self.client.force_authenticate(user=self.student)
        response = self.client.post(f'/api/v1/exams/{self.exam.id}/attempt/')

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        extended_remaining = response.data['time_remaining_seconds']
        self.assertGreaterEqual(extended_remaining, baseline_remaining + (19 * 60))
