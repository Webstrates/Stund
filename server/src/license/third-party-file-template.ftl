<#-- Template for THIRD-PARTY-NOTICES.txt (license-maven-plugin add-third-party).
     Rendering logic mirrors the plugin's default third-party-file.ftl;
     the curation header below is ours. Edit the header here -- the
     generated file at the project root is overwritten on every build.
     Keep this template pure ASCII (the plugin reads it with the
     encoding configured in pom.xml; non-ASCII risks mangling). -->
<#function licenseFormat licenses>
    <#assign result = ""/>
    <#list licenses as license>
        <#assign result = result + " (" +license + ")"/>
    </#list>
    <#return result>
</#function>
<#function artifactFormat p>
    <#if p.name?index_of('Unnamed') &gt; -1>
        <#return p.artifactId + " (" + p.groupId + ":" + p.artifactId + ":" + p.version + " - " + (p.url!"no url defined") + ")">
    <#else>
        <#return p.name + " (" + p.groupId + ":" + p.artifactId + ":" + p.version + " - " + (p.url!"no url defined") + ")">
    </#if>
</#function>
# THIRD-PARTY-NOTICES for SessionHistoryServer
#
# This file is generated automatically on every build by
# license-maven-plugin (add-third-party, bound to generate-resources).
# The header and curation notes live in the template
# src/license/third-party-file-template.ftl -- edit there, not here.
#
#  - Dual-licensed components are used under the first, permissive
#    option listed for each (Jetty: Apache-2.0/EPL-2.0; Jakarta APIs:
#    EPL-2.0/GPL2-with-classpath-exception; JNA: Apache-2.0/LGPL-2.1+;
#    Graal: MIT/UPL).
#
#  - TWO components are GNU LGPL version 3 only and are embedded in the
#    runnable server JAR: the GStreamer Java bindings gst1-java-core
#    (source: the linked repository; also distributed via Maven Central)
#    and the vendored gst1-java-fixups (complete corresponding source
#    ships in libs/ as the -sources jar, see libs/LICENSE).
#
# ---------------------------------------------------------------------
<#if dependencyMap?size == 0>
The project has no dependencies.
<#else>
Lists of ${dependencyMap?size} third-party dependencies.
    <#list dependencyMap as e>
        <#assign project = e.getKey()/>
        <#assign licenses = e.getValue()/>
    ${licenseFormat(licenses)} ${artifactFormat(project)}
    </#list>
</#if>