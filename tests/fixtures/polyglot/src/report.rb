# Ruby fixture: realistic report generator with multiple classes, modules, and metaprogramming.
require 'json'

module Serializable
  def to_json_pretty
    JSON.pretty_generate(to_h)
  end
end

class ReportEntry
  include Serializable

  attr_reader :timestamp, :message, :severity

  def initialize(timestamp:, message:, severity: :info)
    @timestamp = timestamp
    @message = message
    @severity = severity
  end

  def to_h
    {
      timestamp: @timestamp,
      message: @message,
      severity: @severity,
    }
  end
end

class ReportGenerator
  include Serializable

  def initialize(title: 'Untitled', author: 'anonymous')
    @title = title
    @author = author
    @entries = []
  end

  def add_entry(message, severity: :info)
    @entries << ReportEntry.new(
      timestamp: Time.now.utc.iso8601,
      message: message,
      severity: severity,
    )
  end

  def generate_summary(records)
    summary = { total: records.length, by_severity: Hash.new(0) }
    @entries.each do |e|
      summary[:by_severity][e.severity] += 1
    end
    summary
  end

  def render
    {
      title: @title,
      author: @author,
      entry_count: @entries.length,
      entries: @entries.map(&:to_h),
    }
  end
end
