# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/store_submission_status"

class StoreSubmissionStatusTest < Minitest::Test
  def version(version_string, state, platform: "IOS", state_attribute: "appVersionState", id: "id-#{version_string}")
    { "type" => "appStoreVersions", "id" => id,
      "attributes" => { "versionString" => version_string, "platform" => platform, state_attribute => state } }
  end

  def status(versions, wanted = "2.7.0")
    BoardseshStoreSubmissionStatus.ios(versions, wanted)
  end

  def test_an_editable_or_missing_version_is_pending
    missing = status([version("2.6.0", "READY_FOR_DISTRIBUTION")])
    assert_equal "pending", missing.fetch("status")
    assert_equal true, missing.fetch("needsDraft")
    %w[PREPARE_FOR_SUBMISSION READY_FOR_REVIEW].each do |state|
      result = status([version("2.6.0", "READY_FOR_DISTRIBUTION"), version("2.7.0", state)])
      assert_equal "pending", result.fetch("status"), state
      assert_equal state, result.fetch("state")
      assert_equal "id-2.7.0", result.fetch("versionId")
    end
  end

  # deliver's editable-version lookup does not include READY_FOR_REVIEW, so the
  # draft lane would try to create the version again. Resume the review draft instead.
  def test_a_version_in_a_review_draft_is_resumed_without_drafting
    result = status([version("2.7.0", "READY_FOR_REVIEW")])
    assert_equal false, result.fetch("needsDraft")
    assert_includes result.fetch("reason"), "resumes it"
    assert_equal true, status([version("2.7.0", "PREPARE_FOR_SUBMISSION")]).fetch("needsDraft")
    assert_equal false, status([version("2.7.0", "WAITING_FOR_REVIEW")]).fetch("needsDraft")
    assert_equal false, status([version("2.7.0", "REJECTED")]).fetch("needsDraft")
  end

  def test_submitted_approved_or_released_is_done
    %w[WAITING_FOR_REVIEW IN_REVIEW ACCEPTED APPROVED PENDING_DEVELOPER_RELEASE PENDING_APPLE_RELEASE
       PROCESSING_FOR_DISTRIBUTION READY_FOR_DISTRIBUTION READY_FOR_SALE REPLACED_WITH_NEW_VERSION].each do |state|
      assert_equal "done", status([version("2.7.0", state)]).fetch("status"), state
    end
  end

  def test_reads_the_legacy_state_attribute_too
    assert_equal "done", status([version("2.7.0", "WAITING_FOR_REVIEW", state_attribute: "appStoreState")]).fetch("status")
  end

  # Resubmitting a rejection, or a version someone pulled from review, every hour
  # would fight whoever is handling it.
  def test_rejected_pulled_or_invalid_versions_need_a_person
    %w[REJECTED METADATA_REJECTED DEVELOPER_REJECTED INVALID_BINARY].each do |state|
      result = status([version("2.7.0", state)])
      assert_equal "blocked", result.fetch("status"), state
      assert_includes result.fetch("reason"), "Fix and resubmit it in App Store Connect"
      refute_includes result.fetch("reason"), "rename"
    end
  end

  def test_another_version_in_review_defers_and_another_open_version_blocks
    %w[WAITING_FOR_REVIEW IN_REVIEW].each do |state|
      result = status([version("2.6.1", state), version("2.7.0", "PREPARE_FOR_SUBMISSION")])
      assert_equal "deferred", result.fetch("status"), state
      assert_includes result.fetch("reason"), "2.6.1 (#{state})"
    end
    %w[PREPARE_FOR_SUBMISSION READY_FOR_REVIEW].each do |state|
      result = status([version("2.6.1", state)])
      assert_equal "blocked", result.fetch("status"), state
      assert_includes result.fetch("reason"), "will not rename"
    end
    %w[REJECTED DEVELOPER_REJECTED METADATA_REJECTED INVALID_BINARY].each do |state|
      result = status([version("2.6.1", state)])
      assert_equal "blocked", result.fetch("status"), state
      assert_includes result.fetch("reason"), "fixed and resubmitted there"
    end
  end

  # An approved, unreleased version holds the next one until it is released; the
  # draft lane refuses meanwhile, so this waits instead of failing every hour.
  def test_another_approved_unreleased_version_defers
    BoardseshAppStoreVersionStates::APPROVED_UNRELEASED.each do |state|
      %w[appVersionState appStoreState].each do |attribute|
        result = status([version("2.6.1", state, state_attribute: attribute), version("2.7.0", "PREPARE_FOR_SUBMISSION")])
        assert_equal "deferred", result.fetch("status"), "#{state} via #{attribute}"
        assert_includes result.fetch("reason"), "approved and not released yet"
      end
    end
  end

  # The draft lane refuses whenever another version is in any open state, so the
  # status check must never call such a version's successor pending.
  def test_no_state_the_draft_lane_refuses_on_is_reported_pending
    BoardseshAppStoreVersionStates::OPEN.each do |state|
      [nil, "PREPARE_FOR_SUBMISSION"].each do |target_state|
        versions = [version("2.6.1", state)]
        versions << version("2.7.0", target_state) if target_state
        refute_equal "pending", status(versions).fetch("status"), "other version #{state}, target #{target_state.inspect}"
      end
    end
  end

  def test_a_newer_version_supersedes_numerically
    assert_equal "superseded", status([version("2.7.1", "PREPARE_FOR_SUBMISSION"), version("2.7.0", "PREPARE_FOR_SUBMISSION")]).fetch("status")
    assert_equal "superseded", status([version("2.10.0", "READY_FOR_SALE")], "2.9.0").fetch("status")
    assert_equal "pending", status([version("2.9.0", "READY_FOR_SALE")], "2.10.0").fetch("status")
    # Done wins: a released version stays done after the next one is created.
    assert_equal "done", status([version("2.7.1", "PREPARE_FOR_SUBMISSION"), version("2.7.0", "READY_FOR_SALE")]).fetch("status")
  end

  def test_other_platforms_and_unknown_states_are_handled_conservatively
    assert_equal "pending", status([version("2.6.1", "IN_REVIEW", platform: "MAC_OS")]).fetch("status")
    assert_equal "blocked", status([version("2.7.0", "SOMETHING_NEW")]).fetch("status")
  end

  def test_ambiguous_or_invalid_input_fails_closed
    assert_raises(BoardseshStoreSubmissionStatus::Error) { status([version("2.7.0", "PREPARE_FOR_SUBMISSION", id: "a"), version("2.7.0", "READY_FOR_SALE", id: "b")]) }
    ["2.7", "v2.7.0", "", nil].each do |wanted|
      assert_raises(BoardseshStoreSubmissionStatus::Error, wanted.inspect) { status([], wanted) }
    end
  end
end
