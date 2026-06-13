#ifndef JVMTI_AGENT_IFILTER_H
#define JVMTI_AGENT_IFILTER_H

#include <string>
#include <vector>

// Decides whether a given class signature should be captured. Two concrete
// uses: an exception-type filter and a throw-site (location) filter.
class IFilter {
public:
    virtual ~IFilter() = default;
    // true  => keep (capture this exception)
    // false => drop (filtered out)
    virtual bool accept(const std::string& class_signature) const = 0;
    virtual const char* name() const = 0;
};

// Substring/prefix denylist with an optional allowlist. When the allowlist is
// non-empty it becomes allow-only mode: a signature must match the allowlist
// AND avoid the denylist.
class DenyAllowFilter : public IFilter {
public:
    DenyAllowFilter(std::string name,
                    std::vector<std::string> deny,
                    std::vector<std::string> allow);
    bool accept(const std::string& class_signature) const override;
    const char* name() const override { return name_.c_str(); }

private:
    std::string name_;
    std::vector<std::string> deny_;
    std::vector<std::string> allow_;
};

#endif  // JVMTI_AGENT_IFILTER_H
