from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase

from accounts.models import Announcement, User, UserPoints


@override_settings(SECURE_SSL_REDIRECT=False)
class AccountsRegressionTests(APITestCase):
    def _make_user(self, *, email, username, role="student", password="Password123"):
        return User.objects.create_user(
            email=email,
            username=username,
            name=username.title(),
            password=password,
            role=role,
        )

    def test_registration_returns_access_key(self):
        payload = {
            "email": "newstudent@example.com",
            "username": "newstudent",
            "name": "New Student",
            "password": "Password123",
            "password_confirm": "Password123",
            "role": "student",
        }

        response = self.client.post("/api/v1/auth/register/", payload, format="json")

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertIn("access", response.data)
        self.assertNotIn("token", response.data)

    def test_user_list_allows_staff_and_limits_students(self):
        staff = self._make_user(
            email="staff@example.com",
            username="staff1",
            role="staff",
        )
        student = self._make_user(
            email="student@example.com",
            username="student1",
            role="student",
        )

        self.client.force_authenticate(user=staff)
        staff_response = self.client.get("/api/v1/auth/users/")
        self.assertEqual(staff_response.status_code, status.HTTP_200_OK)
        staff_items = staff_response.data.get("results", staff_response.data)
        self.assertEqual(len(staff_items), 2)

        self.client.force_authenticate(user=student)
        student_response = self.client.get("/api/v1/auth/users/")
        self.assertEqual(student_response.status_code, status.HTTP_200_OK)
        student_items = student_response.data.get("results", student_response.data)
        self.assertEqual(len(student_items), 1)
        self.assertEqual(str(student_items[0]["id"]), str(student.id))

    def test_change_password_accepts_documented_confirm_field(self):
        user = self._make_user(
            email="change@example.com",
            username="changeuser",
            role="student",
            password="OldPass123",
        )
        self.client.force_authenticate(user=user)

        response = self.client.post(
            "/api/v1/auth/users/change-password/",
            {
                "old_password": "OldPass123",
                "new_password": "NewPass123",
                "new_password_confirm": "NewPass123",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        user.refresh_from_db()
        self.assertTrue(user.check_password("NewPass123"))

    def test_non_staff_cannot_create_announcements(self):
        student = self._make_user(
            email="annstudent@example.com",
            username="annstudent",
            role="student",
        )
        self.client.force_authenticate(user=student)

        response = self.client.post(
            "/api/v1/auth/staff/announcements/",
            {
                "title": "Unauthorized",
                "content": "Should not be created",
                "target_departments": [],
                "is_active": True,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(Announcement.objects.count(), 0)

    def test_leaderboard_assigns_zero_point_user_correct_rank(self):
        ranked = self._make_user(
            email="ranked@example.com",
            username="ranked",
            role="student",
        )
        current = self._make_user(
            email="current@example.com",
            username="current",
            role="student",
        )
        UserPoints.objects.create(
            user=ranked,
            points=10,
            point_type="exam_complete",
            description="Seed points",
        )

        self.client.force_authenticate(user=current)
        response = self.client.get("/api/v1/auth/leaderboard/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["current_user_rank"], 2)
